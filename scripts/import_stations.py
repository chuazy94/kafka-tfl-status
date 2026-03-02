"""
Import TfL station data into PostgreSQL.

This script downloads station data from the TfL API and imports it into PostGIS.
Run this once after setting up the database.

Usage:
    python import_stations.py
"""
import json
import os
import psycopg2
from psycopg2.extras import execute_values
import requests
from dotenv import load_dotenv
import pprint

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

# TfL API for station data
TFL_STOPPOINTS_URL = "https://api.tfl.gov.uk/StopPoint/Mode/tube"

# Mapping of line IDs to our single-character codes
LINE_CODE_MAP = {
    "bakerloo": "B",
    "central": "C",
    "district": "D",
    "hammersmith-city": "H",
    "jubilee": "J",
    "metropolitan": "M",
    "northern": "N",
    "piccadilly": "P",
    "victoria": "V",
    "waterloo-city": "W",
}


def fetch_stations():
    """Fetch all tube stations from TfL API."""
    print("=" * 60)
    print("STEP 1: Fetching stations from TfL API...")
    print("=" * 60)
    
    params = {}
    app_key = os.getenv("TFL_APP_KEY")
    if app_key:
        print(f"Using TFL_APP_KEY: {app_key[:8]}...")
        params["app_key"] = app_key
    else:
        print("Warning: No TFL_APP_KEY set, using unauthenticated request")
    
    print(f"URL: {TFL_STOPPOINTS_URL}")
    
    response = requests.get(TFL_STOPPOINTS_URL, params=params)
    print(f"Response status: {response.status_code}")
    response.raise_for_status()
    
    data = response.json()
    stop_points = data.get("stopPoints", [])
    print(f"Retrieved {len(stop_points)} stop points from API")
    
    # Print first raw stop point for debugging
    if stop_points:
        print("\n--- Sample raw stop point (first one) ---")
        sample = stop_points[0]
        print(f"  naptanId: {sample.get('naptanId')}")
        print(f"  stationNaptan: {sample.get('stationNaptan')}")
        print(f"  commonName: {sample.get('commonName')}")
        print(f"  lat: {sample.get('lat')}")
        print(f"  lon: {sample.get('lon')}")
        print(f"  modes: {sample.get('modes')}")
        print(f"  lines: {[l.get('id') for l in sample.get('lines', [])]}")
    
    return stop_points


def parse_station(stop_point):
    """Parse a TfL stop point into our station format."""
    # Get the NaptanId as the station code
    code = stop_point.get("stationNaptan") or stop_point.get("naptanId", "")
    
    # Clean up the name (remove "Underground Station" suffix)
    name = stop_point.get("commonName", "")
    name = name.replace(" Underground Station", "").strip()
    
    # Get coordinates
    lat = stop_point.get("lat")
    lng = stop_point.get("lon")
    
    if not lat or not lng:
        return None
    
    # Get lines served by this station
    lines = []
    for line_group in stop_point.get("lineModeGroups", []):
        if line_group.get("modeName") == "tube":
            for line_id in line_group.get("lineIdentifier", []):
                if line_id in LINE_CODE_MAP:
                    lines.append(LINE_CODE_MAP[line_id])
    
    # Also check the lines property
    for line in stop_point.get("lines", []):
        line_id = line.get("id", "")
        if line_id in LINE_CODE_MAP:
            code_char = LINE_CODE_MAP[line_id]
            if code_char not in lines:
                lines.append(code_char)
    
    if not lines:
        return None  # Not a tube station
    
    return {
        "code": code,
        "name": name,
        "lat": lat,
        "lng": lng,
        "lines": lines,
    }


def validate_stations(stations):
    """Validate station data and report any issues."""
    print("\n" + "=" * 60)
    print("STEP 2: Validating parsed stations...")
    print("=" * 60)
    
    issues = []
    max_code_len = 0
    max_name_len = 0
    
    for station in stations:
        code_len = len(station["code"]) if station["code"] else 0
        name_len = len(station["name"]) if station["name"] else 0
        
        max_code_len = max(max_code_len, code_len)
        max_name_len = max(max_name_len, name_len)
        
        if code_len > 20:  # Our new limit
            issues.append(f"Code too long ({code_len} chars): {station['code']}")
        if name_len > 100:
            issues.append(f"Name too long ({name_len} chars): {station['name']}")
        if not station["code"]:
            issues.append(f"Missing code for station: {station['name']}")
    
    print(f"Max code length: {max_code_len} characters")
    print(f"Max name length: {max_name_len} characters")
    
    if issues:
        print(f"\n⚠️  Found {len(issues)} validation issues:")
        for issue in issues[:10]:
            print(f"  - {issue}")
        if len(issues) > 10:
            print(f"  ... and {len(issues) - 10} more")
    else:
        print("✅ All stations validated successfully")
    
    # Print first parsed station
    if stations:
        print("\n--- Sample parsed station (first one) ---")
        pprint.pprint(stations[0])
    
    return len(issues) == 0


def import_stations(stations):
    """Import stations into PostgreSQL."""
    print("\n" + "=" * 60)
    print("STEP 3: Importing stations into PostgreSQL...")
    print("=" * 60)
    
    print(f"Connecting to: {DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['database']}")
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        print("✅ Connected to PostgreSQL")
    except Exception as e:
        print(f"❌ Failed to connect to PostgreSQL: {e}")
        raise
    
    cursor = conn.cursor()
    
    # Prepare data for bulk insert
    values = []
    seen_codes = set()
    
    for station in stations:
        if station["code"] in seen_codes:
            continue
        seen_codes.add(station["code"])
        
        values.append((
            station["code"],
            station["name"],
            f"POINT({station['lng']} {station['lat']})",
            station["lines"],
        ))
    
    print(f"Prepared {len(values)} unique stations for insert")
    
    # Print first value tuple
    if values:
        print("\n--- First row to insert ---")
        print(f"  code: '{values[0][0]}' (len={len(values[0][0])})")
        print(f"  name: '{values[0][1]}' (len={len(values[0][1])})")
        print(f"  location: '{values[0][2]}'")
        print(f"  lines: {values[0][3]}")
    
    # Bulk upsert
    insert_sql = """
        INSERT INTO stations (code, name, location, lines)
        VALUES %s
        ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            location = EXCLUDED.location,
            lines = EXCLUDED.lines
    """
    
    try:
        execute_values(
            cursor,
            insert_sql,
            values,
            template="(%s, %s, ST_GeogFromText(%s), %s)"
        )
        conn.commit()
        print(f"✅ Successfully imported {len(values)} unique stations")
    except Exception as e:
        print(f"❌ Error during insert: {e}")
        conn.rollback()
        
        # Try to find the problematic row
        print("\n--- Checking individual rows for issues ---")
        for i, val in enumerate(values[:5]):  # Check first 5
            print(f"Row {i}: code='{val[0]}' (len={len(val[0])}), name='{val[1][:30]}...'")
        raise
    finally:
        cursor.close()
        conn.close()


def main():
    print("\n" + "=" * 60)
    print("TfL Station Import Script")
    print("=" * 60)
    
    # Fetch stations from TfL API
    stop_points = fetch_stations()
    
    # Parse into our format
    stations = []
    for sp in stop_points:
        station = parse_station(sp)
        if station:
            stations.append(station)
    
    print(f"\nParsed {len(stations)} tube stations from {len(stop_points)} stop points")
    
    # Validate
    validate_stations(stations)
    
    # Import into database
    import_stations(stations)
    
    print("\n" + "=" * 60)
    print("✅ Done!")
    print("=" * 60)


if __name__ == "__main__":
    main()
