import { Pool } from "pg";

// Create a connection pool
const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5435"),
  database: process.env.POSTGRES_DB || "tfl_trains",
  user: process.env.POSTGRES_USER || "tfl",
  password: process.env.POSTGRES_PASSWORD || "tfl_password",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export interface Station {
  code: string;
  name: string;
  lat: number;
  lng: number;
  lines: string[];
}

export interface Line {
  code: string;
  name: string;
  color: string;
}

export interface TrainPosition {
  id: number;
  set_number: string;
  trip_number: string;
  line_code: string;
  station_code: string;
  station_name: string;
  platform_name: string;
  current_location: string;
  time_to_station: string;
  destination: string;
  calculated_lat: number | null;
  calculated_lng: number | null;
  heading: string;
  timestamp: string;
}

export interface Adjacency {
  line_code: string;
  from_station_code: string;
  to_station_code: string;
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
  travel_time_seconds: number | null;
}

export async function getStations(): Promise<Station[]> {
  const result = await pool.query(`
    SELECT 
      code,
      name,
      ST_Y(location::geometry) as lat,
      ST_X(location::geometry) as lng,
      lines
    FROM stations
    WHERE location IS NOT NULL
    ORDER BY name
  `);
  
  return result.rows;
}

export async function getLines(): Promise<Line[]> {
  const result = await pool.query(`
    SELECT code, name, color
    FROM lines
    ORDER BY name
  `);
  
  return result.rows;
}

export async function getLatestTrainPositions(lineCode?: string): Promise<TrainPosition[]> {
  let query = `
    SELECT 
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
    FROM latest_train_positions
  `;
  
  const params: string[] = [];
  
  if (lineCode) {
    query += ` WHERE line_code = $1`;
    params.push(lineCode);
  }
  
  query += ` ORDER BY line_code, set_number`;
  
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getAdjacencies(): Promise<Adjacency[]> {
  const result = await pool.query(`
    SELECT 
      sa.line_code,
      sa.from_station_code,
      sa.to_station_code,
      ST_Y(ST_StartPoint(sa.segment_geometry::geometry)) as from_lat,
      ST_X(ST_StartPoint(sa.segment_geometry::geometry)) as from_lng,
      ST_Y(ST_EndPoint(sa.segment_geometry::geometry)) as to_lat,
      ST_X(ST_EndPoint(sa.segment_geometry::geometry)) as to_lng,
      sa.travel_time_seconds
    FROM station_adjacency sa
    WHERE sa.segment_geometry IS NOT NULL
  `);
  
  return result.rows;
}

// TrackerNet uses different station names than the TfL StopPoint API.
// This alias map resolves known mismatches that can't be handled by fuzzy matching.
const STATION_NAME_ALIASES: Record<string, string> = {
  "edgware road (h & c)": "Edgware Road (Circle Line)",
  "hammersmith (c&h)": "Hammersmith (H&C Line)",
  "hammersmith (h&c)": "Hammersmith (H&C Line)",
  "hammersmith (d&p)": "Hammersmith (Dist&Picc Line)",
  "heathrow terminals 123": "Heathrow Terminals 2 & 3",
  "heathrow terminal 1,2,3": "Heathrow Terminals 2 & 3",
  "watford junction": "Watford",
};

export async function getStationByName(name: string): Promise<Station | null> {
  const cleanName = name
    .replace(/ Underground Station/gi, "")
    .replace(/ Station/gi, "")
    .replace(/ Platform\s*[\d\w\s]+$/gi, "")
    .replace(/\./g, "")
    .replace(/'/g, "'")
    .trim();

  const alias = STATION_NAME_ALIASES[cleanName.toLowerCase()];
  const searchName = alias || cleanName;

  const noApostrophe = searchName.replace(/['']/g, "");
  const withoutParens = searchName.replace(/\s*\(.*?\)/g, "").trim();
  const andToAmp = withoutParens.replace(/ and /gi, " & ");

  const result = await pool.query(`
    SELECT 
      code,
      name,
      ST_Y(location::geometry) as lat,
      ST_X(location::geometry) as lng,
      lines
    FROM stations
    WHERE location IS NOT NULL
      AND (
        LOWER(REPLACE(name, '.', '')) = LOWER($1)
        OR LOWER(REPLACE(name, '.', '')) LIKE LOWER($2)
        OR LOWER(REGEXP_REPLACE(REPLACE(name, '.', ''), '''', '', 'g')) = LOWER($3)
        OR LOWER(REPLACE(name, '.', '')) LIKE LOWER($4)
        OR LOWER(REPLACE(name, '.', '')) = LOWER($5)
        OR LOWER(REPLACE(REGEXP_REPLACE(name, '\\s*\\(.*?\\)', '', 'g'), '.', '')) = LOWER($6)
      )
    ORDER BY 
      CASE
        WHEN LOWER(REPLACE(name, '.', '')) = LOWER($1) THEN 0
        WHEN LOWER(REPLACE(name, '.', '')) = LOWER($5) THEN 1
        WHEN LOWER(REPLACE(name, '.', '')) LIKE LOWER($4) THEN 2
        ELSE 3
      END,
      LENGTH(name)
    LIMIT 1
  `, [searchName, `%${searchName}%`, noApostrophe, `${searchName}%`, andToAmp, withoutParens]);
  
  return result.rows[0] || null;
}

export { pool };
