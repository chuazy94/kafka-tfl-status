import { NextResponse } from "next/server";
import { getLines, getAdjacencies } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [lines, adjacencies] = await Promise.all([
      getLines(),
      getAdjacencies(),
    ]);

    // Build line routes from adjacencies
    const lineRoutes: Record<string, Array<[number, number][]>> = {};

    for (const adj of adjacencies) {
      if (!lineRoutes[adj.line_code]) {
        lineRoutes[adj.line_code] = [];
      }
      lineRoutes[adj.line_code].push([
        [adj.from_lng, adj.from_lat],
        [adj.to_lng, adj.to_lat],
      ]);
    }

    // Convert to GeoJSON with line colors
    const features = lines.map((line) => {
      const segments = lineRoutes[line.code] || [];
      
      return {
        type: "Feature",
        geometry: {
          type: "MultiLineString",
          coordinates: segments,
        },
        properties: {
          code: line.code,
          name: line.name,
          color: line.color,
        },
      };
    });

    const geojson = {
      type: "FeatureCollection",
      features,
      // Also include lines metadata for easy access
      lines: lines.map((line) => ({
        code: line.code,
        name: line.name,
        color: line.color,
      })),
    };

    return NextResponse.json(geojson);
  } catch (error) {
    console.error("Error fetching lines:", error);
    return NextResponse.json(
      { error: "Failed to fetch lines" },
      { status: 500 }
    );
  }
}
