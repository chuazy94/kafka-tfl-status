import { getStationByName, getAdjacencies, Station, Adjacency } from "./db";

// Cache for adjacencies
let adjacencyCache: Adjacency[] | null = null;

interface CalculatedPosition {
  lat: number;
  lng: number;
  confidence: "exact" | "interpolated" | "estimated";
}

interface LocationParseResult {
  type: "at" | "approaching" | "left" | "between" | "unknown";
  station1?: string;
  station2?: string;
}

/**
 * Parse the current_location text into structured data.
 * 
 * Examples:
 * - "At Chiswick Park Platform 1" -> { type: "at", station1: "Chiswick Park" }
 * - "Approaching Mile End" -> { type: "approaching", station1: "Mile End" }
 * - "Left St James's Park" -> { type: "left", station1: "St James's Park" }
 * - "Between Acton Town and Ealing Common" -> { type: "between", station1: "Acton Town", station2: "Ealing Common" }
 * - "At Northfields Sidings" -> { type: "at", station1: "Northfields" }
 * - "Departed Morden" -> { type: "left", station1: "Morden" }
 */
export function parseLocationText(text: string): LocationParseResult {
  if (!text || text.trim() === "") {
    return { type: "unknown" };
  }

  // Pattern: "Between X and Y"
  const betweenMatch = text.match(/^Between\s+(.+?)\s+and\s+(.+)$/i);
  if (betweenMatch) {
    return {
      type: "between",
      station1: cleanStationName(betweenMatch[1]),
      station2: cleanStationName(betweenMatch[2]),
    };
  }

  // Pattern: "At Platform" (bare, no station name — station comes from train data)
  if (/^At\s+Platform$/i.test(text)) {
    return { type: "at" };
  }

  // Pattern: "At X" or "At X Platform N" or "At X Platform 1 and 2" or "At X Sidings"
  const atMatch = text.match(/^At\s+(.+?)(?:\s+Platform\s+[\d\s\w]+)?(?:\s+Sidings?)?$/i);
  if (atMatch && atMatch[1]) {
    return {
      type: "at",
      station1: cleanStationName(atMatch[1]),
    };
  }

  // Pattern: "Approaching X" or "Approaching X Platform N" or "Approaching X Platform 1 and 2"
  const approachingMatch = text.match(/^Approaching\s+(.+?)(?:\s+Platform\s+[\d\s\w]+)?$/i);
  if (approachingMatch && approachingMatch[1]) {
    return {
      type: "approaching",
      station1: cleanStationName(approachingMatch[1]),
    };
  }

  // Pattern: "Left X" or "Departed X"
  const leftMatch = text.match(/^(?:Left|Departed)\s+(.+)$/i);
  if (leftMatch) {
    return {
      type: "left",
      station1: cleanStationName(leftMatch[1]),
    };
  }

  // Pattern: "Leaving X" (treat as just left)
  const leavingMatch = text.match(/^Leaving\s+(.+)$/i);
  if (leavingMatch) {
    return {
      type: "left",
      station1: cleanStationName(leavingMatch[1]),
    };
  }

  // Pattern: "Held at X" (treat as at station)
  const heldMatch = text.match(/^Held\s+(?:at\s+)?(.+)$/i);
  if (heldMatch) {
    return {
      type: "at",
      station1: cleanStationName(heldMatch[1]),
    };
  }

  return { type: "unknown" };
}

/**
 * Clean up station name for database lookup.
 */
function cleanStationName(name: string): string {
  return name
    .replace(/\s+Platform\s+[\d\s\w]+$/gi, "") // Handle "Platform 1", "Platform 1 and 2", etc.
    .replace(/\s+Sidings?/gi, "")
    .replace(/\s+Depot/gi, "")
    .replace(/\s+Yard/gi, "")
    .replace(/\s+Junction/gi, "")
    .replace(/\s*\(.*?\)/g, "") // Remove parenthetical info
    .replace(/\.+$/, "") // Remove trailing periods
    .trim();
}

/**
 * Extract the "next station" name from current_location text.
 * This is useful for display in the UI.
 */
export function getNextStationFromLocation(text: string, fallbackStation?: string): string | null {
  const parsed = parseLocationText(text);
  
  switch (parsed.type) {
    case "at":
      return parsed.station1 || fallbackStation || null;
    case "approaching":
      return parsed.station1 || null;
    case "left":
      return null;
    case "between":
      return parsed.station2 || null;
    default:
      return null;
  }
}

/**
 * Parse time_to_station string (e.g., "2:30", "0:30", "-") into seconds.
 */
export function parseTimeToStation(timeStr: string): number | null {
  if (!timeStr || timeStr === "-" || timeStr === "") {
    return null;
  }

  const match = timeStr.match(/^(\d+):(\d+)$/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return minutes * 60 + seconds;
  }

  return null;
}

const DEFAULT_TRAVEL_TIME_SECONDS = 120;

/**
 * Interpolate a position between two points.
 */
function interpolatePosition(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  fraction: number
): { lat: number; lng: number } {
  return {
    lat: lat1 + (lat2 - lat1) * fraction,
    lng: lng1 + (lng2 - lng1) * fraction,
  };
}

/**
 * Find the adjacency record for a segment, checking both stored directions
 * since each station pair is only stored once in the adjacency table.
 */
function findAdjacency(
  adjacencies: Adjacency[],
  fromCode: string,
  toCode: string,
  lineCode?: string
): Adjacency | undefined {
  const match = (adj: Adjacency) =>
    (adj.from_station_code === fromCode && adj.to_station_code === toCode) ||
    (adj.from_station_code === toCode && adj.to_station_code === fromCode);

  if (lineCode) {
    const lineMatch = adjacencies.find((adj) => adj.line_code === lineCode && match(adj));
    if (lineMatch) return lineMatch;
  }
  return adjacencies.find(match);
}

/**
 * Find all adjacencies connected to a station on a given line.
 * Returns them as { neighborCode, neighborLat, neighborLng, travelTime }
 * normalized so the station in question is always the "from" side.
 */
function findConnectedStations(
  adjacencies: Adjacency[],
  stationCode: string,
  lineCode?: string
): Array<{ code: string; lat: number; lng: number; travelTime: number }> {
  const results: Array<{ code: string; lat: number; lng: number; travelTime: number }> = [];
  for (const adj of adjacencies) {
    if (lineCode && adj.line_code !== lineCode) continue;
    if (adj.from_station_code === stationCode) {
      results.push({
        code: adj.to_station_code,
        lat: adj.to_lat,
        lng: adj.to_lng,
        travelTime: adj.travel_time_seconds ?? DEFAULT_TRAVEL_TIME_SECONDS,
      });
    } else if (adj.to_station_code === stationCode) {
      results.push({
        code: adj.from_station_code,
        lat: adj.from_lat,
        lng: adj.from_lng,
        travelTime: adj.travel_time_seconds ?? DEFAULT_TRAVEL_TIME_SECONDS,
      });
    }
  }
  return results;
}

/**
 * Get the travel time in seconds for a segment, falling back to default.
 */
function getSegmentTravelTime(adjacency: Adjacency | undefined): number {
  return adjacency?.travel_time_seconds ?? DEFAULT_TRAVEL_TIME_SECONDS;
}

/**
 * Compute interpolation fraction from time_to_station and segment travel time.
 * Returns a value between 0 (at start of segment) and 1 (at end of segment).
 */
function timeFraction(timeToStationSeconds: number | null, segmentSeconds: number): number | null {
  if (timeToStationSeconds === null) return null;
  return Math.max(0, Math.min(1, 1 - timeToStationSeconds / segmentSeconds));
}

/**
 * Calculate position based on location text, time to station, and line.
 */
export async function calculatePosition(
  currentLocation: string,
  timeToStation: string,
  targetStationName?: string,
  lineCode?: string
): Promise<CalculatedPosition | null> {
  const parsed = parseLocationText(currentLocation);

  if (!adjacencyCache) {
    adjacencyCache = await getAdjacencies();
  }

  switch (parsed.type) {
    case "at": {
      const stationName = parsed.station1 || targetStationName;
      if (!stationName) return null;

      const station = await getStationByName(stationName);
      if (!station) return null;

      return {
        lat: station.lat,
        lng: station.lng,
        confidence: "exact",
      };
    }

    case "approaching": {
      if (!parsed.station1) return null;

      const targetStation = await getStationByName(parsed.station1);
      if (!targetStation) return null;

      const neighbors = findConnectedStations(adjacencyCache, targetStation.code, lineCode);
      if (neighbors.length > 0) {
        // Pick the neighbor that is NOT the targetStationName (the station we're heading to
        // is targetStation itself, so the neighbor is where we're coming from).
        // If targetStationName matches a neighbor, avoid it — that's ahead, not behind.
        const targetStationObj = targetStationName
          ? await getStationByName(targetStationName)
          : null;
        const prevStation =
          neighbors.find((n) => !targetStationObj || n.code !== targetStationObj.code)
          || neighbors[0];

        const seconds = parseTimeToStation(timeToStation);
        const fraction = timeFraction(seconds, prevStation.travelTime) ?? 0.9;

        const pos = interpolatePosition(
          prevStation.lat,
          prevStation.lng,
          targetStation.lat,
          targetStation.lng,
          fraction
        );
        return { ...pos, confidence: seconds !== null ? "interpolated" : "estimated" };
      }

      return {
        lat: targetStation.lat,
        lng: targetStation.lng,
        confidence: "estimated",
      };
    }

    case "left": {
      if (!parsed.station1) return null;

      const departedStation = await getStationByName(parsed.station1);
      if (!departedStation) return null;

      // targetStationName is the next station the train is heading to
      const nextStationObj = targetStationName
        ? await getStationByName(targetStationName)
        : null;

      const neighbors = findConnectedStations(adjacencyCache, departedStation.code, lineCode);

      if (nextStationObj) {
        // We know exactly where the train is headed — find that adjacency
        const toward = neighbors.find((n) => n.code === nextStationObj.code);
        if (toward) {
          const seconds = parseTimeToStation(timeToStation);
          const fraction = timeFraction(seconds, toward.travelTime) ?? 0.1;

          const pos = interpolatePosition(
            departedStation.lat,
            departedStation.lng,
            nextStationObj.lat,
            nextStationObj.lng,
            fraction
          );
          return { ...pos, confidence: seconds !== null ? "interpolated" : "estimated" };
        }
      }

      // Fallback: pick first available neighbor
      if (neighbors.length > 0) {
        const neighbor = neighbors[0];
        const seconds = parseTimeToStation(timeToStation);
        const fraction = timeFraction(seconds, neighbor.travelTime) ?? 0.1;

        const pos = interpolatePosition(
          departedStation.lat,
          departedStation.lng,
          neighbor.lat,
          neighbor.lng,
          fraction
        );
        return { ...pos, confidence: seconds !== null ? "interpolated" : "estimated" };
      }

      return {
        lat: departedStation.lat,
        lng: departedStation.lng,
        confidence: "estimated",
      };
    }

    case "between": {
      if (!parsed.station1 || !parsed.station2) return null;

      const station1 = await getStationByName(parsed.station1);
      const station2 = await getStationByName(parsed.station2);

      if (!station1 || !station2) return null;

      const adjacency = findAdjacency(adjacencyCache, station1.code, station2.code, lineCode);
      const segmentTime = getSegmentTravelTime(adjacency);

      const seconds = parseTimeToStation(timeToStation);
      const fraction = timeFraction(seconds, segmentTime) ?? 0.5;

      const pos = interpolatePosition(
        station1.lat,
        station1.lng,
        station2.lat,
        station2.lng,
        fraction
      );

      return {
        ...pos,
        confidence: seconds !== null ? "interpolated" : "estimated",
      };
    }

    default:
      if (targetStationName) {
        const station = await getStationByName(targetStationName);
        if (station) {
          return {
            lat: station.lat,
            lng: station.lng,
            confidence: "estimated",
          };
        }
      }
      return null;
  }
}

/**
 * Predict the next station a train will depart toward, based on its
 * current station and the direction of its final destination.
 * Uses straight-line distance as a heuristic to pick the correct neighbor.
 */
export async function predictNextStation(
  currentStationName: string,
  destinationName: string,
  lineCode?: string
): Promise<{ lat: number; lng: number; travelTime: number } | null> {
  // Skip prediction at terminal stations (train has reached its destination
  // and will reverse — we can't reliably predict the new direction)
  const normCurrent = currentStationName.replace(/\./g, "").trim().toLowerCase();
  const normDest = destinationName.replace(/\./g, "").trim().toLowerCase();
  if (normCurrent === normDest) return null;

  if (!adjacencyCache) {
    adjacencyCache = await getAdjacencies();
  }

  const currentStation = await getStationByName(currentStationName);
  if (!currentStation) return null;

  const destStation = await getStationByName(destinationName);
  if (!destStation) return null;

  // Also skip if the resolved station codes match (handles naming variants)
  if (currentStation.code === destStation.code) return null;

  const neighbors = findConnectedStations(adjacencyCache, currentStation.code, lineCode);
  if (neighbors.length === 0) return null;
  if (neighbors.length === 1) return neighbors[0];

  // Pick the neighbor whose straight-line distance to the destination is smallest
  let best = neighbors[0];
  let bestDist = Infinity;
  for (const n of neighbors) {
    const d = (n.lat - destStation.lat) ** 2 + (n.lng - destStation.lng) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/**
 * Clear the adjacency cache (useful after importing new data).
 */
export function clearAdjacencyCache(): void {
  adjacencyCache = null;
}
