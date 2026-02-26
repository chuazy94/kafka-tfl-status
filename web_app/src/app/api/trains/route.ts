import { NextRequest, NextResponse } from "next/server";
import { getLatestTrainPositions, getStationByName, Station } from "@/lib/db";
import { calculatePosition, getNextStationFromLocation, parseLocationText, parseTimeToStation } from "@/lib/position-calculator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const lineCode = searchParams.get("line") || undefined;

    const trains = await getLatestTrainPositions(lineCode);

    // Pre-fetch all unique destination stations in parallel to avoid per-train DB calls
    const uniqueStationNames = [...new Set(trains.map((t) => t.station_name).filter(Boolean))];
    const stationCache = new Map<string, Station | null>();
    await Promise.all(
      uniqueStationNames.map(async (name) => {
        stationCache.set(name, await getStationByName(name));
      })
    );

    // Track statistics for debugging
    let positioned = 0;
    let fallbackUsed = 0;
    let missing = 0;

    // Calculate positions for ALL trains - try multiple fallbacks
    const trainsWithPositions = await Promise.all(
      trains.map(async (train) => {
        const toStation = stationCache.get(train.station_name) ?? null;
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
          // Priority 2: Calculate from current_location text
          const position = await calculatePosition(
            train.current_location,
            train.time_to_station,
            train.station_name,
            train.line_code
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

        return {
          ...train,
          lat,
          lng,
          position_confidence,
          to_lat: toStation?.lat ?? null,
          to_lng: toStation?.lng ?? null,
          time_to_station_seconds: timeToStationSeconds,
        };
      })
    );

    // Filter out trains without positions (but log the count)
    const validTrains = trainsWithPositions.filter(
      (train) => train.lat !== null && train.lng !== null
    );

    // Log statistics periodically
    if (missing > 0) {
      console.log(
        `Train positions: ${positioned} calculated, ${fallbackUsed} fallback, ${missing} missing (${validTrains.length}/${trains.length} shown)`
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
          },
        };
      }),
    };

    return NextResponse.json(geojson);
  } catch (error) {
    console.error("Error fetching trains:", error);
    return NextResponse.json(
      { error: "Failed to fetch train positions" },
      { status: 500 }
    );
  }
}
