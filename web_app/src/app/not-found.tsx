export default function NotFound() {
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#1a1a2e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <h1 style={{ color: "white", fontSize: "2rem", marginBottom: "0.5rem" }}>
          404
        </h1>
        <p style={{ color: "#9ca3af" }}>Page not found</p>
      </div>
    </div>
  );
}
