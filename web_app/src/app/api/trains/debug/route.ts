import { NextRequest, NextResponse } from "next/server";
import { getLatestTrainPositions } from "@/lib/db";
import { calculatePosition, parseLocationText } from "@/lib/position-calculator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Debug endpoint to show all trains and why some might be missing from the map.
 * 
 * GET /api/trains/debug?line=V
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const lineCode = searchParams.get("line") || undefined;

    const trains = await getLatestTrainPositions(lineCode);

    // Analyze each train
    const analysis = await Promise.all(
      trains.map(async (train) => {
        const parsed = parseLocationText(train.current_location);
        
        // Try to calculate position
        const position = await calculatePosition(
          train.current_location,
          train.time_to_station,
          train.station_name
        );

        return {
          set_number: train.set_number,
          trip_number: train.trip_number,
          line_code: train.line_code,
          station_name: train.station_name,
          current_location: train.current_location,
          time_to_station: train.time_to_station,
          destination: train.destination,
          // Analysis
          location_parse_result: parsed,
          has_precalculated_position: !!(train.calculated_lat && train.calculated_lng),
          calculated_position: position,
          will_show_on_map: !!(
            (train.calculated_lat && train.calculated_lng) || position
          ),
          reason_if_missing: !position && !train.calculated_lat
            ? parsed.type === "unknown"
              ? `Location text "${train.current_location}" doesn't match any pattern`
              : `Could not find station(s) in database for "${train.current_location}"`
            : null,
        };
      })
    );

    // Summary statistics
    const total = analysis.length;
    const visible = analysis.filter((t) => t.will_show_on_map).length;
    const missing = analysis.filter((t) => !t.will_show_on_map);

    // Group missing by reason
    const missingByReason: Record<string, string[]> = {};
    for (const train of missing) {
      const reason = train.reason_if_missing || "unknown";
      if (!missingByReason[reason]) {
        missingByReason[reason] = [];
      }
      missingByReason[reason].push(train.set_number);
    }

    // Get unique set_numbers to check for duplicates
    const setNumbers = trains.map((t) => t.set_number);
    const uniqueSetNumbers = [...new Set(setNumbers)];
    const duplicates = setNumbers.length - uniqueSetNumbers.length;

    return NextResponse.json({
      summary: {
        total_trains_in_db: total,
        visible_on_map: visible,
        missing_from_map: total - visible,
        duplicate_set_numbers: duplicates,
        line_filter: lineCode || "all",
      },
      missing_trains: missing.map((t) => ({
        set_number: t.set_number,
        line_code: t.line_code,
        current_location: t.current_location,
        reason: t.reason_if_missing,
        parse_result: t.location_parse_result,
      })),
      missing_by_reason: missingByReason,
      // Full analysis (can be verbose)
      all_trains: analysis,
    });
  } catch (error) {
    console.error("Error in debug endpoint:", error);
    return NextResponse.json(
      { error: "Failed to analyze trains" },
      { status: 500 }
    );
  }
}
