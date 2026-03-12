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
          <div style={{ padding: "1rem", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
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
                  Last update: {new Date(latestTimestamp).toLocaleString()}
                </div>
              )}
            </div>

            {/* Author Footer */}
            <div style={{ marginTop: "auto", paddingTop: "1.5rem", borderTop: "1px solid rgba(55, 65, 81, 0.5)" }}>
              <div style={{ fontSize: "0.7rem", color: "#6b7280", marginBottom: "0.5rem" }}>
                Built by <span style={{ color: "#d1d5db", fontWeight: "500" }}>Zhi Yuan Chua</span>
              </div>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <a
                  href="https://github.com/chuazy94/kafka-tfl-status"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.7rem", color: "#9ca3af", textDecoration: "none" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f8fafc")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#9ca3af")}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                  Source
                </a>
                <a
                  href="https://chuazy94.github.io/zy_blog_2/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.7rem", color: "#9ca3af", textDecoration: "none" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f8fafc")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#9ca3af")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  Blog
                </a>
              </div>
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
