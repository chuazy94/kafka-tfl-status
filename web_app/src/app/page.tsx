"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import LineSelector from "@/components/LineSelector";
import { useTrainAnimation } from "@/hooks/useTrainAnimation";

const Map = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100vw", height: "100vh", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "white", fontSize: "1.25rem" }}>Loading map...</div>
    </div>
  ),
});

export default function Home() {
  const [selectedLine, setSelectedLine] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { trains, trainCount, latestTimestamp } = useTrainAnimation(selectedLine);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

  if (!mapboxToken) {
    return (
      <div style={{ width: "100vw", height: "100vh", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ color: "white", fontSize: "1.5rem", marginBottom: "1rem" }}>Mapbox Token Required</h1>
          <p style={{ color: "#9ca3af" }}>Please set NEXT_PUBLIC_MAPBOX_TOKEN in your .env.local file.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Full-screen Map */}
      <div id="map-wrapper" style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh" }}>
        <Map accessToken={mapboxToken} selectedLine={selectedLine} trains={trains} />
      </div>

      {/* Floating Sidebar */}
      {sidebarOpen && (
        <div
          id="sidebar"
          style={{
            position: "fixed",
            top: "1rem",
            left: "1rem",
            bottom: "1rem",
            width: "16rem",
            background: "rgba(17, 24, 39, 0.95)",
            backdropFilter: "blur(8px)",
            borderRadius: "0.75rem",
            border: "1px solid rgba(55, 65, 81, 0.5)",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "1rem", height: "100%", overflowY: "auto" }}>
            {/* Header */}
            <div style={{ marginBottom: "1.5rem" }}>
              <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", color: "white", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ fontSize: "1.5rem" }}>🚇</span>
                TfL Train Tracker
              </h1>
              <p style={{ color: "#9ca3af", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                Real-time tube train positions
              </p>
            </div>

            {/* Line Filter */}
            <div>
              <h2 style={{ fontSize: "0.75rem", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>
                Filter by Line
              </h2>
              <LineSelector
                selectedLine={selectedLine}
                onSelectLine={setSelectedLine}
              />
            </div>

            {/* Data Status */}
            <div style={{ marginTop: "1.5rem", padding: "0.75rem", background: "rgba(255, 255, 255, 0.05)", borderRadius: "0.5rem" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>
                Tracking <span style={{ color: "white", fontWeight: "600" }}>{trainCount}</span> trains
              </div>
              {latestTimestamp && (
                <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>
                  Last update: {new Date(latestTimestamp).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toggle Button */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{
          position: "fixed",
          top: "1rem",
          left: sidebarOpen ? "18rem" : "1rem",
          background: "rgba(17, 24, 39, 0.95)",
          backdropFilter: "blur(8px)",
          color: "white",
          padding: "0.5rem",
          borderRadius: "0.5rem",
          border: "1px solid rgba(55, 65, 81, 0.5)",
          boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
          cursor: "pointer",
          zIndex: 1001,
          transition: "left 0.3s ease",
        }}
      >
        {sidebarOpen ? "◀" : "▶"}
      </button>

      {/* Legend */}
      <div
        id="legend"
        style={{
          position: "fixed",
          bottom: "1rem",
          right: "1rem",
          background: "rgba(17, 24, 39, 0.95)",
          backdropFilter: "blur(8px)",
          color: "white",
          padding: "0.75rem 1rem",
          borderRadius: "0.75rem",
          border: "1px solid rgba(55, 65, 81, 0.5)",
          fontSize: "0.75rem",
          zIndex: 1000,
        }}
      >
        <div style={{ fontWeight: "600", marginBottom: "0.5rem" }}>Legend</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
          <span style={{ width: "0.75rem", height: "0.75rem", borderRadius: "50%", background: "white", border: "1px solid #6b7280" }} />
          Station
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ width: "0.75rem", height: "0.75rem", borderRadius: "50%", background: "#3b82f6", border: "2px solid white" }} />
          Train
        </div>
      </div>
    </>
  );
}
