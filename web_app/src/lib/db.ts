import { Pool } from "pg";

// Connects via DATABASE_URL (single connection string) or individual POSTGRES_* env vars.
// Works the same in all environments: local dev, Vercel, Oracle VM.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_SSLMODE === "require" ? { rejectUnauthorized: false } : false,
    })
  : new Pool({
      host: process.env.POSTGRES_HOST || "localhost",
      port: parseInt(process.env.POSTGRES_PORT || "5435"),
      database: process.env.POSTGRES_DB || "tfl_trains",
      user: process.env.POSTGRES_USER || "tfl",
      password: process.env.POSTGRES_PASSWORD || "tfl_password",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function query(text: string, params?: unknown[]): Promise<{ rows: any[] }> {
  return pool.query(text, params);
}

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
  const result = await query(`
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
  
  return result.rows as Station[];
}

export async function getLines(): Promise<Line[]> {
  const result = await query(`
    SELECT code, name, color
    FROM lines
    ORDER BY name
  `);
  
  return result.rows as Line[];
}

export async function getLatestTrainPositions(lineCode?: string): Promise<TrainPosition[]> {
  let sql = `
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
    sql += ` WHERE line_code = $1`;
    params.push(lineCode);
  }
  
  sql += ` ORDER BY line_code, set_number`;
  
  const result = await query(sql, params);
  return result.rows as TrainPosition[];
}

/** Check if a station exists on a given line (has at least one adjacency). */
export async function isStationOnLine(stationCode: string, lineCode: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM station_adjacency 
     WHERE line_code = $1 AND (from_station_code = $2 OR to_station_code = $2) 
     LIMIT 1`,
    [lineCode, stationCode]
  );
  return result.rows.length > 0;
}

/** Get all station codes on a line (one query, for batch validation). */
export async function getStationCodesOnLine(lineCode: string): Promise<Set<string>> {
  const result = await query(
    `SELECT DISTINCT from_station_code as code FROM station_adjacency WHERE line_code = $1
     UNION
     SELECT DISTINCT to_station_code FROM station_adjacency WHERE line_code = $1`,
    [lineCode]
  );
  return new Set(result.rows.map((r: { code: string }) => r.code));
}

export async function getAdjacencies(): Promise<Adjacency[]> {
  const result = await query(`
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
  
  return result.rows as Adjacency[];
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

// In-memory station cache: loads all ~330 stations once, refreshes every hour.
// Eliminates ~50-100 DB round trips per /api/trains call.
let allStationsCache: Station[] | null = null;
let stationsCacheTimestamp = 0;
const STATIONS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getAllStationsCached(): Promise<Station[]> {
  const now = Date.now();
  if (allStationsCache && now - stationsCacheTimestamp < STATIONS_CACHE_TTL) {
    return allStationsCache;
  }
  allStationsCache = await getStations();
  stationsCacheTimestamp = now;
  return allStationsCache;
}

// In-memory cache for station codes per line (adjacency data is static)
const stationCodesOnLineCache = new Map<string, { data: Set<string>; timestamp: number }>();

export async function getStationCodesOnLineCached(lineCode: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = stationCodesOnLineCache.get(lineCode);
  if (cached && now - cached.timestamp < STATIONS_CACHE_TTL) {
    return cached.data;
  }
  const data = await getStationCodesOnLine(lineCode);
  stationCodesOnLineCache.set(lineCode, { data, timestamp: now });
  return data;
}

function fuzzyMatchStation(name: string, stations: Station[]): Station | null {
  const cleanName = name
    .replace(/ Underground Station/gi, "")
    .replace(/ Station/gi, "")
    .replace(/ Platform\s*[\d\w\s]+$/gi, "")
    .replace(/\./g, "")
    .replace(/'/g, "'")
    .trim();

  const alias = STATION_NAME_ALIASES[cleanName.toLowerCase()];
  const searchName = alias || cleanName;
  const searchLower = searchName.toLowerCase();

  const noApostrophe = searchName.replace(/['']/g, "").toLowerCase();
  const withoutParens = searchName.replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
  const andToAmp = withoutParens.replace(/ and /gi, " & ");

  let bestMatch: Station | null = null;
  let bestPriority = 99;

  for (const station of stations) {
    const dbName = station.name.replace(/\./g, "").toLowerCase();
    const dbNoApostrophe = dbName.replace(/['']/g, "");
    const dbNoParens = station.name.replace(/\s*\(.*?\)/g, "").replace(/\./g, "").trim().toLowerCase();

    let priority = 99;

    if (dbName === searchLower) {
      priority = 0; // exact match
    } else if (dbName === andToAmp) {
      priority = 1; // "and" → "&" match
    } else if (dbName.startsWith(searchLower)) {
      priority = 2; // prefix match
    } else if (dbNoApostrophe === noApostrophe) {
      priority = 3; // apostrophe-insensitive match
    } else if (dbNoParens === withoutParens) {
      priority = 4; // parenthetical-insensitive match
    } else if (dbName.includes(searchLower)) {
      priority = 5; // contains match
    }

    if (priority < bestPriority || (priority === bestPriority && bestMatch && station.name.length < bestMatch.name.length)) {
      bestPriority = priority;
      bestMatch = station;
    }
  }

  return bestMatch;
}

export async function getStationByName(name: string): Promise<Station | null> {
  const stations = await getAllStationsCached();
  return fuzzyMatchStation(name, stations);
}
