import { NextRequest, NextResponse } from "next/server";
import { getLatestTrainPositions, getStationByName, getStationCodesOnLineCached, Station, type TrainPosition } from "@/lib/db";
import { calculatePosition, getNextStationFromLocation, parseLocationText, parseTimeToStation, predictNextStation } from "@/lib/position-calculator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Cache the fully-processed GeoJSON response per line filter.
// The expensive work (DB view query + fuzzy station matching + position calculation)
// only needs to run once per data refresh cycle (~30s from the producer).
const responseCache = new Map<string, { json: object; timestamp: number }>();
const RESPONSE_CACHE_TTL = 10_000; // 10 seconds

/** Collect all station names needed for filtering (from current_location parsing). */
function getStationNamesForFilter(trains: TrainPosition[]): Set<string> {
  const names = new Set<string>();
  for (const train of trains) {
    const parsed = parseLocationText(train.current_location);
    if (parsed.type === "at") {
      if (parsed.station1) names.add(parsed.station1);
      else if (train.station_name) names.add(train.station_name.replace(/\.$/, "").trim());
    } else if (parsed.type === "approaching" || parsed.type === "left") {
      if (parsed.station1) names.add(parsed.station1);
    } else if (parsed.type === "between" && parsed.station1 && parsed.station2) {
      names.add(parsed.station1);
      names.add(parsed.station2);
    } else if (train.station_name) {
      names.add(train.station_name.replace(/\.$/, "").trim());
    }
  }
  return names;
}

/** Collect all station names needed for position calculation and prediction. */
function getStationNamesForPositions(trains: TrainPosition[]): Set<string> {
  const names = new Set<string>();
  for (const train of trains) {
    if (train.station_name) names.add(train.station_name.replace(/\.$/, "").trim());
    if (train.destination) names.add(train.destination.replace(/\.$/, "").trim());
    const parsed = parseLocationText(train.current_location);
    if (parsed.station1) names.add(parsed.station1);
    if (parsed.station2) names.add(parsed.station2);
  }
  return names;
}

/**
 * Filter out spurious duplicate records: when the same physical train appears on multiple
 * lines (e.g. 205 on D, H, M) with the same current_location, keep only records where
 * the location station is actually on that line.
 */
function filterTrainsByLineValidation(
  trains: TrainPosition[],
  stationCache: Map<string, Station | null>,
  stationsOnLineByLine: Map<string, Set<string>>
): TrainPosition[] {
  const filtered: TrainPosition[] = [];
  for (const train of trains) {
    const parsed = parseLocationText(train.current_location);
    let stationNames: string[] = [];

    if (parsed.type === "at") {
      stationNames = parsed.station1 ? [parsed.station1] : (train.station_name ? [train.station_name.replace(/\.$/, "").trim()] : []);
    } else if (parsed.type === "approaching" || parsed.type === "left") {
      stationNames = parsed.station1 ? [parsed.station1] : [];
    } else if (parsed.type === "between") {
      stationNames = parsed.station1 && parsed.station2 ? [parsed.station1, parsed.station2] : [];
    } else {
      stationNames = train.station_name ? [train.station_name.replace(/\.$/, "").trim()] : [];
    }

    if (stationNames.length === 0) {
      filtered.push(train);
      continue;
    }

    const stationsOnLine = train.line_code ? stationsOnLineByLine.get(train.line_code) : new Set<string>();
    const allOnLine = !train.line_code || (stationsOnLine && stationNames.every((name) => {
      const station = stationCache.get(name) ?? stationCache.get(name.replace(/\.$/, "").trim());
      return station && stationsOnLine.has(station.code);
    }));
    if (allOnLine) filtered.push(train);
  }
  return filtered;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const lineCode = searchParams.get("line") || undefined;
    const cacheKey = lineCode ?? "__all__";

    // Return cached response if still fresh — avoids re-running all the
    // station fuzzy matching and position calculation on rapid polls.
    const now = Date.now();
    const cached = responseCache.get(cacheKey);
    if (cached && now - cached.timestamp < RESPONSE_CACHE_TTL) {
      return NextResponse.json(cached.json);
    }

    const t0 = Date.now();
    const trains = await getLatestTrainPositions(lineCode);
    const t1 = Date.now();

    // Batch-fetch all stations needed (filter + positions + predictions) in parallel
    const filterNames = getStationNamesForFilter(trains);
    const positionNames = getStationNamesForPositions(trains);
    const allNames = [...new Set([...filterNames, ...positionNames])];
    const uniqueLineCodes = [...new Set(trains.map((t) => t.line_code).filter(Boolean))];

    const [stationResults, ...lineResults] = await Promise.all([
      Promise.all(allNames.map((name) => getStationByName(name))),
      ...uniqueLineCodes.map((lc) => getStationCodesOnLineCached(lc!)),
    ]);
    const t2 = Date.now();

    const stationCache = new Map<string, Station | null>();
    allNames.forEach((name, i) => {
      stationCache.set(name, stationResults[i]);
    });

    const stationsOnLineByLine = new Map<string, Set<string>>();
    uniqueLineCodes.forEach((lc, i) => {
      if (lc) stationsOnLineByLine.set(lc, lineResults[i] as Set<string>);
    });

    const filteredTrains = filterTrainsByLineValidation(trains, stationCache, stationsOnLineByLine);

    // Track statistics for debugging
    let positioned = 0;
    let fallbackUsed = 0;
    let missing = 0;

    // Calculate positions for ALL trains - try multiple fallbacks (stationCache avoids per-train DB calls)
    const trainsWithPositions = await Promise.all(
      filteredTrains.map(async (train) => {
        const stationKey = train.station_name?.replace(/\.$/, "").trim() ?? "";
        const toStation = stationCache.get(stationKey) ?? null;
        const timeToStationSeconds = parseTimeToStation(train.time_to_station);

        let lat: number | null = null;
        let lng: number | null = null;
        let position_confidence = "none";

        // Priority 1: Pre-calculated coordinates from PySpark
        if (train.calculated_lat && train.calculated_lng) {
          lat = train.calculated_lat;
          lng = train.calculated_lng;
          position_confidence = "precalculated";
          positioned++;
        } else {
          // Priority 2: Calculate from current_location text (stationCache avoids DB calls)
          const position = await calculatePosition(
            train.current_location,
            train.time_to_station,
            train.station_name,
            train.line_code,
            stationCache
          );

          if (position) {
            lat = position.lat;
            lng = position.lng;
            position_confidence = position.confidence;
            positioned++;
          } else if (toStation) {
            // Priority 3: Fallback to destination station coordinates
            lat = toStation.lat;
            lng = toStation.lng;
            position_confidence = "station_fallback";
            fallbackUsed++;
          } else {
            missing++;
            console.warn(
              `Train ${train.set_number} has no position: location="${train.current_location}", station="${train.station_name}"`
            );
          }
        }

        // For trains at platform (time_to_station = "-"), predict the next station
        // so the client can animate a predicted departure after dwell time
        let predicted_next_lat: number | null = null;
        let predicted_next_lng: number | null = null;
        let predicted_travel_time: number | null = null;

        if (timeToStationSeconds === null && train.station_name && train.destination) {
          const nextStn = await predictNextStation(
            train.station_name,
            train.destination,
            train.line_code,
            stationCache
          );
          if (nextStn) {
            predicted_next_lat = nextStn.lat;
            predicted_next_lng = nextStn.lng;
            predicted_travel_time = nextStn.travelTime;
          }
        }

        return {
          ...train,
          lat,
          lng,
          position_confidence,
          to_lat: toStation?.lat ?? null,
          to_lng: toStation?.lng ?? null,
          time_to_station_seconds: timeToStationSeconds,
          predicted_next_lat,
          predicted_next_lng,
          predicted_travel_time,
        };
      })
    );

    const t3 = Date.now();

    // Filter out trains without positions (but log the count)
    const validTrains = trainsWithPositions.filter(
      (train) => train.lat !== null && train.lng !== null
    );

    console.log(
      `[/api/trains] line=${lineCode ?? "ALL"} trains=${trains.length} stations=${allNames.length} | ` +
      `db=${t1 - t0}ms lookup=${t2 - t1}ms positions=${t3 - t2}ms total=${t3 - t0}ms`
    );

    // Log statistics periodically
    if (missing > 0) {
      console.log(
        `Train positions: ${positioned} calculated, ${fallbackUsed} fallback, ${missing} missing (${validTrains.length}/${filteredTrains.length} shown)`
      );
    }

    // Convert to GeoJSON for easy Mapbox integration
    const geojson = {
      type: "FeatureCollection",
      features: validTrains.map((train) => {
        const locationInfo = parseLocationText(train.current_location);
        const stationLabel = train.station_name?.replace(/\.$/, "") || "";
        const nextStation = getNextStationFromLocation(train.current_location, stationLabel);

        // Enrich "At Platform" with the actual station name for display
        let displayLocation = train.current_location;
        if (locationInfo.type === "at" && !locationInfo.station1 && stationLabel) {
          displayLocation = `At ${stationLabel}`;
        }

        return {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [train.lng, train.lat],
          },
          properties: {
            id: train.id,
            set_number: train.set_number,
            trip_number: train.trip_number,
            line_code: train.line_code,
            station_name: train.station_name,
            current_location: displayLocation,
            location_type: locationInfo.type,
            next_station: nextStation,
            time_to_station: train.time_to_station,
            destination: train.destination,
            timestamp: train.timestamp,
            // Dead-reckoning params for smooth client-side animation
            from_lat: train.lat,
            from_lng: train.lng,
            to_lat: train.to_lat,
            to_lng: train.to_lng,
            time_to_station_seconds: train.time_to_station_seconds,
            data_timestamp: train.timestamp,
            predicted_next_lat: train.predicted_next_lat,
            predicted_next_lng: train.predicted_next_lng,
            predicted_travel_time: train.predicted_travel_time,
          },
        };
      }),
    };

    responseCache.set(cacheKey, { json: geojson, timestamp: Date.now() });
    return NextResponse.json(geojson);
  } catch (error) {
    console.error("Error fetching trains:", error);
    return NextResponse.json(
      { error: "Failed to fetch train positions" },
      { status: 500 }
    );
  }
}
