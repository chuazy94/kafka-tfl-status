-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Static reference data: Stations
CREATE TABLE IF NOT EXISTS stations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,  -- TfL NaptanIds are ~12 chars (e.g., 940GZZLUACT)
    name VARCHAR(100) NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    lines TEXT[]  -- Array of line codes this station serves
);

-- Static reference data: Tube Lines
CREATE TABLE IF NOT EXISTS lines (
    id SERIAL PRIMARY KEY,
    code CHAR(1) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL,
    color VARCHAR(7) NOT NULL,  -- Hex color code
    route GEOGRAPHY(LINESTRING, 4326)
);

-- Station adjacency for position interpolation
CREATE TABLE IF NOT EXISTS station_adjacency (
    id SERIAL PRIMARY KEY,
    line_code CHAR(1) NOT NULL REFERENCES lines(code),
    from_station_code VARCHAR(20) NOT NULL,
    to_station_code VARCHAR(20) NOT NULL,
    sequence_order INT NOT NULL,
    segment_geometry GEOGRAPHY(LINESTRING, 4326),
    travel_time_seconds INT,  -- Scheduled travel time between stations (from TfL Timetable API)
    UNIQUE(line_code, from_station_code, to_station_code)
);

-- Real-time train positions (from PySpark consumer)
CREATE TABLE IF NOT EXISTS train_positions (
    id SERIAL PRIMARY KEY,
    set_number VARCHAR(20) NOT NULL,
    trip_number VARCHAR(20),
    line_code CHAR(1),
    station_code VARCHAR(20),
    station_name VARCHAR(100),
    platform_name VARCHAR(100),
    platform_code VARCHAR(10),
    current_location TEXT,
    time_to_station VARCHAR(20),
    destination VARCHAR(100),
    calculated_lat DOUBLE PRECISION,
    calculated_lng DOUBLE PRECISION,
    heading VARCHAR(20),
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_stations_code ON stations(code);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);
CREATE INDEX IF NOT EXISTS idx_stations_location ON stations USING GIST(location);

CREATE INDEX IF NOT EXISTS idx_lines_code ON lines(code);

CREATE INDEX IF NOT EXISTS idx_adjacency_line ON station_adjacency(line_code);
CREATE INDEX IF NOT EXISTS idx_adjacency_from ON station_adjacency(from_station_code);
CREATE INDEX IF NOT EXISTS idx_adjacency_to ON station_adjacency(to_station_code);

CREATE INDEX IF NOT EXISTS idx_train_positions_timestamp ON train_positions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_train_positions_set ON train_positions(set_number);
CREATE INDEX IF NOT EXISTS idx_train_positions_line ON train_positions(line_code);

-- Insert tube line reference data
INSERT INTO lines (code, name, color) VALUES
    ('B', 'Bakerloo', '#B36305'),
    ('C', 'Central', '#E32017'),
    ('D', 'District', '#00782A'),
    ('H', 'Hammersmith & Circle', '#F3A9BB'),
    ('J', 'Jubilee', '#A0A5A9'),
    ('M', 'Metropolitan', '#9B0056'),
    ('N', 'Northern', '#000000'),
    ('P', 'Piccadilly', '#003688'),
    ('V', 'Victoria', '#0098D4'),
    ('W', 'Waterloo & City', '#95CDBA')
ON CONFLICT (code) DO NOTHING;

-- View to get latest position for each train
-- Uses the global latest batch timestamp to ensure ALL active trains are shown
-- Newest poll wins first, then within the same poll: '-' > 'due' > smallest time_to_station
CREATE OR REPLACE VIEW latest_train_positions AS
WITH 
-- Get the latest batch timestamp (most recent data poll)
latest_batch AS (
    SELECT MAX(timestamp) as batch_ts FROM train_positions
),
-- Get all records from the latest batch (within 2 minutes to handle any timing variance)
batch_records AS (
    SELECT tp.*
    FROM train_positions tp, latest_batch lb
    WHERE tp.timestamp >= lb.batch_ts - INTERVAL '2 minutes'
)
SELECT DISTINCT ON (set_number)
    id,
    set_number,
    trip_number,
    line_code,
    station_code,
    station_name,
    platform_name,
    current_location,
    time_to_station,
    destination,
    calculated_lat,
    calculated_lng,
    heading,
    timestamp
FROM batch_records
ORDER BY 
    set_number,
    timestamp DESC,
    CASE 
        WHEN time_to_station = '-' THEN 0
        WHEN LOWER(time_to_station) = 'due' THEN 1
        WHEN time_to_station ~ '^\d+:\d+$' THEN
            2 + (SPLIT_PART(time_to_station, ':', 1)::INT * 60) + SPLIT_PART(time_to_station, ':', 2)::INT
        ELSE 999999
    END ASC;

-- Function to clean up old train position data
-- Usage: SELECT cleanup_old_train_positions('1 day');
CREATE OR REPLACE FUNCTION cleanup_old_train_positions(retention_interval INTERVAL DEFAULT INTERVAL '1 day')
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM train_positions 
    WHERE timestamp < NOW() - retention_interval;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % old train position records', deleted_count;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
