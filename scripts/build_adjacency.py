"""
Build station adjacency graph from TfL line route data.

This creates the station_adjacency table which maps
which stations are connected on each line.

Usage:
    python build_adjacency.py
"""
import os
import psycopg2
from psycopg2.extras import execute_values
import requests
from dotenv import load_dotenv

load_dotenv()

# Database connection
DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": os.getenv("POSTGRES_PORT", "5435"),
    "database": os.getenv("POSTGRES_DB", "tfl_trains"),
    "user": os.getenv("POSTGRES_USER", "tfl"),
    "password": os.getenv("POSTGRES_PASSWORD", "tfl_password"),
    "sslmode": os.getenv("POSTGRES_SSLMODE", "prefer"),
}

# TfL API for line route data
TFL_LINE_ROUTE_URL = "https://api.tfl.gov.uk/Line/{line_id}/Route/Sequence/all"

# Line IDs and their codes
LINES = {
    "bakerloo": "B",
    "central": "C",
    "circle": "H",
    "district": "D",
    "hammersmith-city": "H",
    "jubilee": "J",
    "metropolitan": "M",
    "northern": "N",
    "piccadilly": "P",
    "victoria": "V",
    "waterloo-city": "W",
}


def fetch_line_route(line_id):
    """Fetch route sequence for a line from TfL API."""
    url = TFL_LINE_ROUTE_URL.format(line_id=line_id)
    
    params = {}
    app_key = os.getenv("TFL_APP_KEY")
    if app_key:
        params["app_key"] = app_key
    
    response = requests.get(url, params=params)
    response.raise_for_status()
    
    return response.json()


def extract_station_sequence(route_data):
    """Extract ordered list of stations from route data."""
    sequences = []
    
    # The API returns orderedLineRoutes which contain stopPointSequences
    for ordered_route in route_data.get("orderedLineRoutes", []):
        for stop_sequence in route_data.get("stopPointSequences", []):
            branch_name = stop_sequence.get("branchId", "main")
            direction = stop_sequence.get("direction", "unknown")
            
            stations = []
            for stop in stop_sequence.get("stopPoint", []):
                station_code = stop.get("stationId") or stop.get("id", "")
                station_name = stop.get("name", "").replace(" Underground Station", "")
                
                if station_code:
                    stations.append({
                        "code": station_code,
                        "name": station_name,
                        "lat": stop.get("lat"),
                        "lon": stop.get("lon"),
                    })
            
            if stations:
                sequences.append({
                    "branch": branch_name,
                    "direction": direction,
                    "stations": stations,
                })
    
    return sequences


def build_adjacency_pairs(line_code, sequences):
    """Build adjacency pairs from station sequences."""
    adjacencies = []
    seen = set()
    
    for seq in sequences:
        stations = seq["stations"]
        for i in range(len(stations) - 1):
            from_station = stations[i]
            to_station = stations[i + 1]
            
            # Create unique key (sorted to avoid duplicates in both directions)
            pair_key = tuple(sorted([from_station["code"], to_station["code"]]))
            
            if pair_key not in seen:
                seen.add(pair_key)
                
                # Create adjacency in both directions
                adjacencies.append({
                    "line_code": line_code,
                    "from_code": from_station["code"],
                    "to_code": to_station["code"],
                    "from_lat": from_station["lat"],
                    "from_lon": from_station["lon"],
                    "to_lat": to_station["lat"],
                    "to_lon": to_station["lon"],
                    "sequence": i,
                })
    
    return adjacencies


def import_adjacencies(adjacencies):
    """Import adjacencies into PostgreSQL."""
    print(f"Importing {len(adjacencies)} adjacencies into PostgreSQL...")
    
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()
    
    # Clear existing adjacencies
    cursor.execute("DELETE FROM station_adjacency")
    
    # Prepare values
    values = []
    for adj in adjacencies:
        # Create a simple line segment between the two stations
        if adj["from_lat"] and adj["from_lon"] and adj["to_lat"] and adj["to_lon"]:
            linestring = f"LINESTRING({adj['from_lon']} {adj['from_lat']}, {adj['to_lon']} {adj['to_lat']})"
        else:
            linestring = None
        
        values.append((
            adj["line_code"],
            adj["from_code"],
            adj["to_code"],
            adj["sequence"],
            linestring,
        ))
    
    # Filter out any with None linestrings
    values = [v for v in values if v[4] is not None]
    
    # Bulk insert
    insert_sql = """
        INSERT INTO station_adjacency (line_code, from_station_code, to_station_code, sequence_order, segment_geometry)
        VALUES %s
        ON CONFLICT (line_code, from_station_code, to_station_code) DO UPDATE SET
            sequence_order = EXCLUDED.sequence_order,
            segment_geometry = EXCLUDED.segment_geometry
    """
    
    execute_values(
        cursor,
        insert_sql,
        values,
        template="(%s, %s, %s, %s, ST_GeogFromText(%s))"
    )
    
    conn.commit()
    cursor.close()
    conn.close()
    
    print(f"Successfully imported {len(values)} adjacencies")


def main():
    all_adjacencies = []
    seen_global = set()
    
    for line_id, line_code in LINES.items():
        print(f"Processing {line_id} line...")
        
        try:
            route_data = fetch_line_route(line_id)
            sequences = extract_station_sequence(route_data)
            adjacencies = build_adjacency_pairs(line_code, sequences)
            
            # Deduplicate across lines sharing the same code (e.g. circle + hammersmith-city)
            new_adjacencies = []
            for adj in adjacencies:
                key = (adj["line_code"], adj["from_code"], adj["to_code"])
                if key not in seen_global:
                    seen_global.add(key)
                    new_adjacencies.append(adj)
            
            print(f"  Found {len(new_adjacencies)} new adjacencies for {line_id}")
            all_adjacencies.extend(new_adjacencies)
            
        except Exception as e:
            print(f"  Error processing {line_id}: {e}")
    
    # Import all adjacencies
    import_adjacencies(all_adjacencies)
    
    print("Done!")


if __name__ == "__main__":
    main()
