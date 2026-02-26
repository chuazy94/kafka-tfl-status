"""
SQLite database initialization script for TfL predictions.
Run this once before starting the PySpark streaming consumer.

Usage:
    python init_db.py
"""
import sqlite3

SQLITE_DB_PATH = "tfl_predictions.db"


def init_sqlite_db():
    """Initialize SQLite database with predictions table."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_code TEXT,
            station_name TEXT,
            platform_name TEXT,
            platform_code TEXT,
            trip_number TEXT,
            set_number TEXT,
            time_to_station TEXT,
            destination TEXT,
            current_location TEXT,
            ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Create indexes for common queries
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_station_code ON predictions(station_code)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_station_name ON predictions(station_name)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_ingested_at ON predictions(ingested_at)
    ''')
    
    conn.commit()
    conn.close()
    print(f"SQLite database initialized at {SQLITE_DB_PATH}")


if __name__ == "__main__":
    init_sqlite_db()
