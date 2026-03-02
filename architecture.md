# Architecture

## Local Development

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                     TFL TUBE PREDICTIONS STREAMING PIPELINE                         │
│                              (Docker Compose)                                       │
│                                                                                     │
│  STEP 1: INGEST              STEP 2: BUFFER           STEP 3: PROCESS & LOAD       │
│  ─────────────────           ─────────────            ──────────────────────        │
│                                                                                     │
│  ┌───────────────────┐       ┌─────────────────┐      ┌────────────────────────┐   │
│  │  TfL TrackerNet   │       │  KAFKA CLUSTER  │      │    SPARK STREAMING     │   │
│  │  API              │       │                 │      │                        │   │
│  │                   │       │  ┌───────────┐  │      │  1. Read from Kafka    │   │
│  │  /predictionsummary       │  │  Topic:   │  │      │  2. Parse XML          │   │
│  │  (XML Response)   │       │  │  tube-    │  │      │  3. Convert to JSON    │   │
│  └─────────┬─────────┘       │  │prediction-│  │      │  4. Transform/Enrich   │   │
│            │                 │  │timings-   │  │      │  5. Write to PostgreSQL │   │
│            ▼                 │  │topic      │  │      │                        │   │
│  ┌───────────────────┐       │  └─────┬─────┘  │      └───────────┬────────────┘   │
│  │  Kafka Producer   │──────►│        │        │◄─────────────────┘               │
│  │  (Python)         │       │        │        │                                   │
│  │                   │       │        │        │                                   │
│  │  Polls API every  │       └────────┼────────┘                                   │
│  │  30 seconds       │                │                                            │
│  └───────────────────┘                ▼                                            │
│                              ┌─────────────────┐      ┌────────────────────────┐   │
│                              │  PostgreSQL +   │      │  Next.js Frontend      │   │
│                              │  PostGIS        │◄─────│  (localhost:3000)      │   │
│                              │                 │      │                        │   │
│                              │  train_positions │      │  Mapbox GL + Live     │   │
│                              │  stations        │      │  Train Animation      │   │
│                              │  station_adjacency      │                        │   │
│                              └─────────────────┘      └────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Production

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
  ORACLE CLOUD VM (Always Free: 4 ARM cores, 24GB RAM, 200GB disk)
│                                                                                   │

│ ┌───────────────────┐     ┌─────────────────┐     ┌────────────────────────┐     │
  │  TfL TrackerNet   │     │  KAFKA           │     │  PySpark Streaming     │
│ │  API              │     │  (Docker)        │     │  (Docker)              │     │
  │                   │     │                  │     │                        │
│ └─────────┬─────────┘     │  tube-prediction-│     │  Reads from Kafka      │     │
            │               │  timings-topic   │     │  Parses XML
│           ▼               │                  │     │  Writes to Neon PG ────────┐ │
  ┌───────────────────┐     └──────▲───┬───────┘     └────────────────────────┘  │
│ │  Kafka Producer   │────────────┘   │                                         │ │
  │  (Docker)         │                │             ┌────────────────────────┐  │
│ │                   │                │             │  db-cleanup            │  │ │
  │  Polls API every  │                │             │  (Docker)              │  │
│ │  30 seconds       │                │             │  Runs every 1hr ───────────┤ │
  └───────────────────┘                │             └────────────────────────┘  │
│                                      │                                         │ │
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─
                                       │                                         │
                                       │              SQL (SSL/TLS)              │
                                       │                                         │
                                       │    ┌────────────────────────────────┐   │
                                       │    │  NEON (Free Tier)              │◄──┘
                                       │    │  PostgreSQL 16 + PostGIS       │
                                       │    │                                │
                                       │    │  Tables:                       │
                                       │    │   stations (341 rows)          │
                                       │    │   lines (10 rows)              │
                                       │    │   station_adjacency (362 rows) │
                                       │    │   train_positions (rolling)    │
                                       │    └──────────────┬─────────────────┘
                                       │                   │
                                       │                   │ SQL query (SSL/TLS)
                                       │                   │
                                       │    ┌──────────────┴─────────────────┐
                                       │    │  VERCEL (Free Tier)            │
                                       │    │  Next.js 15                    │
                                       │    │                                │
                                       │    │  API Routes:                   │
                                       │    │   /api/trains → GeoJSON        │
                                       │    │   /api/lines  → line segments  │
                                       │    │   /api/stations → station data │
                                       │    │                                │
                                       │    │  Frontend:                     │
                                       │    │   Mapbox GL + live animation   │
                                       │    └────────────────────────────────┘
                                       │
                                       │    ┌────────────────────────────────┐
                                       │    │  MAPBOX (Free Tier)            │
                                       └───►│  50,000 map loads/month        │
                                            │  Dark map tiles                │
                                            └────────────────────────────────┘
```

## Data Flow

1. **Ingest** — Python Kafka producer polls TfL TrackerNet API every 30s for all 10 tube lines
2. **Buffer** — Raw XML responses buffered in Kafka topic `tube-prediction-timings-topic`
3. **Process** — PySpark Streaming reads from Kafka, parses XML, extracts train predictions
4. **Store** — Transformed records written to PostgreSQL `train_positions` table (Neon in prod)
5. **Serve** — Next.js API routes query latest positions, compute GeoJSON with interpolated coordinates
6. **Display** — Browser renders trains on Mapbox map with dead-reckoning animation between polls
