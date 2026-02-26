"""
Import inter-station travel times from the TfL Timetable API.

For each tube line, fetches the scheduled timetable from a terminal station
and extracts the time between consecutive stops. These travel times are stored
in the station_adjacency table's travel_time_seconds column.

Usage:
    python import_travel_times.py
"""
import os
import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": os.getenv("POSTGRES_PORT", "5435"),
    "database": os.getenv("POSTGRES_DB", "tfl_trains"),
    "user": os.getenv("POSTGRES_USER", "tfl"),
    "password": os.getenv("POSTGRES_PASSWORD", "tfl_password"),
}

TFL_TIMETABLE_URL = "https://api.tfl.gov.uk/Line/{line_id}/Timetable/{station_id}"

LINES = {
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

DEFAULT_TRAVEL_TIME_SECONDS = 120


def get_terminal_stations(cursor):
    """
    For each line, find terminal stations (those that appear as from_station
    at sequence_order 0, i.e. the start of a route branch).
    """
    cursor.execute("""
        SELECT DISTINCT sa.line_code, sa.from_station_code, s.name
        FROM station_adjacency sa
        JOIN stations s ON s.code = sa.from_station_code
        WHERE sa.sequence_order = 0
        ORDER BY sa.line_code
    """)
    rows = cursor.fetchall()

    terminals = {}
    for line_code, station_code, station_name in rows:
        terminals.setdefault(line_code, []).append({
            "code": station_code,
            "name": station_name,
        })

    return terminals


def fetch_timetable(line_id, station_id):
    """Fetch timetable for a line from a given station."""
    url = TFL_TIMETABLE_URL.format(line_id=line_id, station_id=station_id)

    params = {}
    app_key = os.getenv("TFL_APP_KEY")
    if app_key:
        params["app_key"] = app_key

    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()


def extract_segment_times(timetable_data):
    """
    Extract inter-station travel times from timetable data.

    The API returns stationIntervals with cumulative timeToArrival in minutes.
    We difference consecutive stops to get per-segment times.

    Returns dict of (from_station_code, to_station_code) -> seconds.
    """
    segment_times = {}

    routes = timetable_data.get("timetable", {}).get("routes", [])
    departure_station = timetable_data.get("timetable", {}).get("departureStopId", "")

    for route in routes:
        for interval_set in route.get("stationIntervals", []):
            intervals = interval_set.get("intervals", [])
            if not intervals:
                continue

            prev_stop_id = departure_station
            prev_cumulative = 0.0

            for interval in intervals:
                stop_id = interval.get("stopId", "")
                cumulative_minutes = interval.get("timeToArrival", 0.0)
                segment_minutes = cumulative_minutes - prev_cumulative

                if stop_id and prev_stop_id and segment_minutes > 0:
                    pair = (prev_stop_id, stop_id)
                    segment_seconds = int(round(segment_minutes * 60))

                    if pair not in segment_times:
                        segment_times[pair] = segment_seconds
                    else:
                        # Average with existing value if we see the same pair multiple times
                        segment_times[pair] = (segment_times[pair] + segment_seconds) // 2

                prev_stop_id = stop_id
                prev_cumulative = cumulative_minutes

    return segment_times


def update_travel_times(cursor, line_code, segment_times):
    """Update station_adjacency rows with travel times for a given line."""
    updated = 0
    unmatched = []

    for (from_code, to_code), seconds in segment_times.items():
        # Try both directions since adjacency might be stored either way
        cursor.execute("""
            UPDATE station_adjacency
            SET travel_time_seconds = %s
            WHERE line_code = %s
              AND (
                  (from_station_code = %s AND to_station_code = %s)
                  OR (from_station_code = %s AND to_station_code = %s)
              )
        """, (seconds, line_code, from_code, to_code, to_code, from_code))

        if cursor.rowcount > 0:
            updated += cursor.rowcount
        else:
            unmatched.append((from_code, to_code, seconds))

    return updated, unmatched


def set_defaults(cursor):
    """Set default travel time for any segments still missing data."""
    cursor.execute("""
        UPDATE station_adjacency
        SET travel_time_seconds = %s
        WHERE travel_time_seconds IS NULL
    """, (DEFAULT_TRAVEL_TIME_SECONDS,))
    return cursor.rowcount


def main():
    print("=" * 60)
    print("TfL Inter-Station Travel Time Import")
    print("=" * 60)

    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()

    # Ensure the column exists (for existing databases)
    cursor.execute("""
        ALTER TABLE station_adjacency
        ADD COLUMN IF NOT EXISTS travel_time_seconds INT
    """)
    conn.commit()

    terminals = get_terminal_stations(cursor)
    if not terminals:
        print("No terminal stations found. Run build_adjacency.py first.")
        return

    print(f"Found terminal stations for {len(terminals)} lines\n")

    total_updated = 0
    all_unmatched = []

    for line_id, line_code in LINES.items():
        line_terminals = terminals.get(line_code, [])
        if not line_terminals:
            print(f"  [{line_code}] {line_id}: No terminal stations in adjacency table, skipping")
            continue

        print(f"  [{line_code}] {line_id}:")
        line_segment_times = {}

        for terminal in line_terminals:
            try:
                print(f"      Fetching timetable from {terminal['name']} ({terminal['code']})...")
                data = fetch_timetable(line_id, terminal["code"])
                segment_times = extract_segment_times(data)
                print(f"      -> Extracted {len(segment_times)} segment times")

                # Merge into line-level dict (keep first seen or average)
                for pair, seconds in segment_times.items():
                    if pair not in line_segment_times:
                        line_segment_times[pair] = seconds
                    else:
                        line_segment_times[pair] = (line_segment_times[pair] + seconds) // 2

            except requests.exceptions.HTTPError as e:
                print(f"      -> HTTP error: {e}")
            except Exception as e:
                print(f"      -> Error: {e}")

        if line_segment_times:
            updated, unmatched = update_travel_times(cursor, line_code, line_segment_times)
            total_updated += updated
            all_unmatched.extend([(line_code, *u) for u in unmatched])
            print(f"      Updated {updated} adjacency rows, {len(unmatched)} unmatched segments")
        else:
            print(f"      No segment times extracted")

        print()

    # Fill in defaults for any remaining NULL values
    defaults_set = set_defaults(cursor)
    if defaults_set > 0:
        print(f"Set default ({DEFAULT_TRAVEL_TIME_SECONDS}s) for {defaults_set} segments without timetable data")

    conn.commit()
    cursor.close()
    conn.close()

    print(f"\nTotal adjacency rows updated with real times: {total_updated}")
    if all_unmatched:
        print(f"\nUnmatched segments ({len(all_unmatched)}):")
        for line_code, from_code, to_code, seconds in all_unmatched[:20]:
            print(f"  [{line_code}] {from_code} -> {to_code}: {seconds}s")
        if len(all_unmatched) > 20:
            print(f"  ... and {len(all_unmatched) - 20} more")

    print("\nDone!")


if __name__ == "__main__":
    main()
