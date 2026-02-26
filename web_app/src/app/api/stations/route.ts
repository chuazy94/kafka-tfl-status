import { NextRequest, NextResponse } from "next/server";
import { getStations } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const lineCode = searchParams.get("line");

    let stations = await getStations();

    // Filter by line if specified
    if (lineCode) {
      stations = stations.filter((station) =>
        station.lines?.includes(lineCode)
      );
    }

    // Convert to GeoJSON
    const geojson = {
      type: "FeatureCollection",
      features: stations.map((station) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [station.lng, station.lat],
        },
        properties: {
          code: station.code,
          name: station.name,
          lines: station.lines,
        },
      })),
    };

    return NextResponse.json(geojson);
  } catch (error) {
    console.error("Error fetching stations:", error);
    return NextResponse.json(
      { error: "Failed to fetch stations" },
      { status: 500 }
    );
  }
}
