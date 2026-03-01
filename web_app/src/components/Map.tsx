"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const LINE_COLORS: Record<string, string> = {
  B: "#B36305", // Bakerloo
  C: "#E32017", // Central
  D: "#00782A", // District
  H: "#F3A9BB", // Hammersmith & Circle
  J: "#A0A5A9", // Jubilee
  M: "#9B0056", // Metropolitan
  N: "#000000", // Northern
  P: "#003688", // Piccadilly
  V: "#0098D4", // Victoria
  W: "#95CDBA", // Waterloo & City
};

interface TrainGeoJSON {
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
}

interface MapProps {
  accessToken: string;
  selectedLine?: string;
  trains: TrainGeoJSON;
}

export default function Map({ accessToken, selectedLine, trains }: MapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    if (!accessToken) return;

    mapboxgl.accessToken = accessToken;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-0.1276, 51.5074],
      zoom: 11,
      minZoom: 9,
      maxZoom: 16,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.current.on("load", async () => {
      if (!map.current) return;

      // Load stations
      try {
        const stationsResponse = await fetch("/api/stations");
        const stationsData = await stationsResponse.json();

        if (!stationsData.error) {
          map.current.addSource("stations", {
            type: "geojson",
            data: stationsData,
          });

          map.current.addLayer({
            id: "stations-layer",
            type: "circle",
            source: "stations",
            paint: {
              "circle-radius": 4,
              "circle-color": "#ffffff",
              "circle-stroke-width": 1,
              "circle-stroke-color": "#666666",
            },
          });

          map.current.addLayer({
            id: "stations-labels",
            type: "symbol",
            source: "stations",
            layout: {
              "text-field": ["get", "name"],
              "text-size": 10,
              "text-offset": [0, 1.5],
              "text-anchor": "top",
            },
            paint: {
              "text-color": "#ffffff",
              "text-halo-color": "#000000",
              "text-halo-width": 1,
            },
            minzoom: 13,
          });
        }
      } catch (error) {
        console.error("Error loading stations:", error);
      }

      // Load line routes
      try {
        const linesResponse = await fetch("/api/lines");
        const linesData = await linesResponse.json();

        if (!linesData.error) {
          map.current.addSource("lines", {
            type: "geojson",
            data: linesData,
          });

          map.current.addLayer(
            {
              id: "lines-layer",
              type: "line",
              source: "lines",
              paint: {
                "line-color": ["get", "color"],
                "line-width": 3,
                "line-opacity": 0.8,
                "line-offset": ["coalesce", ["get", "line_offset"], 0],
              },
            },
            "stations-layer"
          );
        }
      } catch (error) {
        console.error("Error loading lines:", error);
      }

      // Add trains source
      map.current.addSource("trains", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.current.addLayer({
        id: "trains-layer",
        type: "circle",
        source: "trains",
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "match",
            ["get", "line_code"],
            "B", LINE_COLORS.B,
            "C", LINE_COLORS.C,
            "D", LINE_COLORS.D,
            "H", LINE_COLORS.H,
            "J", LINE_COLORS.J,
            "M", LINE_COLORS.M,
            "N", LINE_COLORS.N,
            "P", LINE_COLORS.P,
            "V", LINE_COLORS.V,
            "W", LINE_COLORS.W,
            "#888888",
          ],
          "circle-stroke-width": [
            "match", ["get", "line_code"],
            "H", 3,
            2,
          ],
          "circle-stroke-color": [
            "match", ["get", "line_code"],
            "H", "#FFD300",
            "#ffffff",
          ],
        },
      });

      map.current.addLayer({
        id: "trains-labels",
        type: "symbol",
        source: "trains",
        layout: {
          "text-field": ["get", "set_number"],
          "text-size": 8,
          "text-offset": [0, 2],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 1,
        },
        minzoom: 13,
      });

      // Train click popup
      map.current.on("click", "trains-layer", (e) => {
        if (!e.features || e.features.length === 0) return;

        const feature = e.features[0];
        const coords = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
        const props = feature.properties;

        const locationType = props?.location_type;
        const nextStation = props?.next_station;
        const timeToStation = props?.time_to_station;

        let etaDisplay = "";
        if (locationType === "at") {
          const stationLabel = nextStation || props?.station_name || "station";
          etaDisplay = `<span style="color: #4ade80;">● At ${stationLabel}</span>`;
        } else if (nextStation && timeToStation && timeToStation !== "-") {
          etaDisplay = `Next: <strong>${nextStation}</strong> in ${timeToStation}`;
        } else if (timeToStation && timeToStation !== "-") {
          etaDisplay = `ETA: ${timeToStation}`;
        } else {
          etaDisplay = `Status: ${locationType || "unknown"}`;
        }

        new mapboxgl.Popup()
          .setLngLat(coords)
          .setHTML(`
            <div style="color: #333; padding: 8px; min-width: 180px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: ${LINE_COLORS[props?.line_code] || "#666"};"></span>
                <strong>Train ${props?.set_number}</strong>
              </div>
              <div style="font-size: 12px; color: #666; margin-bottom: 4px;">
                ${props?.current_location}
              </div>
              <div style="margin-bottom: 4px;">
                ${etaDisplay}
              </div>
              <div style="font-size: 11px; color: #888; border-top: 1px solid #eee; padding-top: 4px; margin-top: 4px;">
                Destination: ${props?.destination}
              </div>
            </div>
          `)
          .addTo(map.current!);
      });

      // Cursor changes
      map.current.on("mouseenter", "trains-layer", () => {
        if (map.current) map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", "trains-layer", () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
      });

      // Station hover popup
      let stationPopup: mapboxgl.Popup | null = null;

      map.current.on("mouseenter", "stations-layer", (e) => {
        if (!map.current || !e.features || e.features.length === 0) return;
        map.current.getCanvas().style.cursor = "pointer";

        const feature = e.features[0];
        const coords = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
        const stationName = feature.properties?.name || "Unknown Station";
        const lines = feature.properties?.lines;

        let linesList: string[] = [];
        if (typeof lines === "string") {
          try {
            linesList = JSON.parse(lines);
          } catch {
            linesList = [lines];
          }
        } else if (Array.isArray(lines)) {
          linesList = lines;
        }

        const lineBadges = linesList
          .map((line: string) => {
            const color = LINE_COLORS[line] || "#666";
            return `<span style="display: inline-block; width: 16px; height: 16px; border-radius: 50%; background: ${color}; margin-right: 4px;" title="${line} line"></span>`;
          })
          .join("");

        stationPopup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10,
        })
          .setLngLat(coords)
          .setHTML(`
            <div style="padding: 8px; min-width: 120px;">
              <div style="font-weight: bold; margin-bottom: 4px;">${stationName}</div>
              <div style="display: flex; flex-wrap: wrap;">${lineBadges}</div>
            </div>
          `)
          .addTo(map.current);
      });

      map.current.on("mouseleave", "stations-layer", () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
        if (stationPopup) {
          stationPopup.remove();
          stationPopup = null;
        }
      });

      setMapLoaded(true);
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, [accessToken]);

  // Update trains
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    const source = map.current.getSource("trains") as mapboxgl.GeoJSONSource;
    if (source) {
      source.setData(trains);
    }
  }, [trains, mapLoaded]);

  // Filter by line
  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    if (selectedLine) {
      map.current.setFilter("lines-layer", ["==", ["get", "code"], selectedLine]);
      map.current.setFilter("stations-layer", ["in", selectedLine, ["get", "lines"]]);
    } else {
      map.current.setFilter("lines-layer", null);
      map.current.setFilter("stations-layer", null);
    }
  }, [selectedLine, mapLoaded]);

  return (
    <div
      ref={mapContainer}
      style={{
        width: "100vw",
        height: "100vh",
      }}
    />
  );
}
