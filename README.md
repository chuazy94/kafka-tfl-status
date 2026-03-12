# TfL Train Visualizer

Real-time visualization of London Underground train positions on a geographic map. Uses Kafka to stream the TFL predictions dataset into a postgres database.

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- A Mapbox account (for map access token)

## Setup

### 1. Start PostgreSQL with PostGIS

From the `kafka_config` directory:

```bash
cd ../kafka_config
docker compose up -d postgres
```

### 2. Import Station Data

```bash
cd ../scripts
pip install -r requirements.txt

# Set your TfL API key (optional but recommended)
export TFL_APP_KEY=your_key_here

# Import stations
python import_stations.py

# Build adjacency graph
python build_adjacency.py
```

### 3. Configure Environment Variables

Create a `.env.local` file in the `web_app` directory:

```bash
# Mapbox (get a token from https://mapbox.com)
NEXT_PUBLIC_MAPBOX_TOKEN=

# PostgreSQL (match docker-compose settings)
POSTGRES_HOST=localhost
POSTGRES_PORT=5435
POSTGRES_DB=tfl_trains
POSTGRES_USER=tfl
POSTGRES_PASSWORD=tfl_password
```

### 4. Install Dependencies and Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Architecture

```
TfL API → Kafka Producer → Kafka → PySpark Consumer → PostgreSQL
                                                           ↓
                                              Next.js API ← 
                                                           ↓
                                              Mapbox GL (Frontend)
```

## Features

- Real-time train positions on a geographic map
- Filter by tube line
- Smooth animation between data updates
- Train info popups on click
- Station markers and labels

## API Endpoints

- `GET /api/trains` - Current train positions (GeoJSON)
- `GET /api/trains?line=V` - Filter by line code
- `GET /api/stations` - Station locations (GeoJSON)
- `GET /api/lines` - Line routes and colors (GeoJSON)

## Technical Notes

### Data Structure & Transformation

The TfL TrackerNet API (`/PredictionSummary/{line}`) returns XML containing prediction data for each tube line. Each response contains nested `<S>` (station), `<P>` (platform), and `<T>` (train) elements. The Kafka producer polls all 10 line codes every 30 seconds and publishes raw XML to Kafka with `line_code` embedded in the message headers. PySpark Structured Streaming then consumes from Kafka, parses the XML via a UDF, and explodes the nested structure into flat rows with fields like `set_number`, `station_name`, `current_location`, `time_to_station`, and `destination`. These are written to PostgreSQL in micro-batches every 10 seconds.

### Database Schema

The key tables are `stations` (imported from TfL StopPoint API with PostGIS geography points), `lines` (10 tube lines with hex colours), `station_adjacency` (sequential station pairs per line with segment geometry), and `train_positions` (rolling append-only table of every prediction record). The critical piece is the `latest_train_positions` **view**, which uses a CTE to find the most recent batch timestamp, then selects `DISTINCT ON (set_number)` within a 2-minute window. Ties are broken by preferring `time_to_station = '-'` (at platform) over `'due'` over numeric ETAs — ensuring each train appears once with its most informative record.

### Position Calculation

TrackerNet does not provide geographic coordinates for trains. Positions are calculated from the `current_location` free-text field using regex pattern matching. The parser recognises patterns like `"At {station} Platform {n}"`, `"Approaching {station}"`, `"Left {station}"`, `"Between {station1} and {station2}"`, `"Departed {station}"`, and `"Held at {station}"`. Once parsed, the station names are resolved to lat/lng via the stations table, and the `time_to_station` field is used to interpolate along the segment between two known points. For example, a train "Between Acton Town and Ealing Common" with `time_to_station = "0:30"` is placed 75% of the way along that segment (assuming a 120-second default travel time). Trains that can't be positioned are logged and excluded from the API response.

### Station Name Resolution

TrackerNet and the StopPoint API use different naming conventions. For example, TrackerNet returns `"Edgware Road (H & C)."` while the database has `"Edgware Road (Circle Line)"`, and `"Heathrow Terminals 123"` maps to `"Heathrow Terminals 2 & 3"`. This is handled by a station name alias map for known mismatches, plus fuzzy matching that strips parenthetical suffixes, normalises `"and"` vs `"&"`, removes trailing periods, and tries prefix/LIKE matches as fallbacks. The Circle line and Hammersmith & City line share TfL line code `H`, so both are rendered together — the sidebar shows dual pink/yellow dots, and the map draws parallel offset lines.

### Station Adjacency Graph

The adjacency graph is built by the `build_adjacency.py` script, which calls the TfL Line Route Sequence API for each tube line. This returns ordered lists of station NaptanIds representing each branch of a line. The script walks each sequence pairwise to create `(from_station, to_station)` adjacency records and constructs PostGIS `LINESTRING` geometry for each segment using the station coordinates. This graph powers both the route rendering on the map and the position interpolation — when a train is "between" two stations or "approaching" one, the adjacency data provides the geometry to interpolate along.

### Client-Side Animation

The frontend polls the API every 10 seconds but animates train positions at 60fps using dead-reckoning. Each train has a `from` position, a `to` position (next station), and an ETA. Between polls, the client linearly interpolates along this trajectory based on elapsed wall-clock time. When new data arrives, a 1.5-second ease-out blend reconciles any discrepancy between the predicted and actual position. Trains that temporarily disappear from the API (e.g., unresolvable position in one poll) are retained for 90 seconds before removal, preventing flicker. For trains at the same station, a small geographic offset arranges them in a circle so both are visible and clickable.

### Predicted Departure Animation

When a train is at a platform (`time_to_station = "-"`), it has no ETA so dead-reckoning can't move it. After 30 seconds of dwell, the client begins a predicted departure animation toward the next station. The next station is determined server-side using the adjacency graph and the train's final destination (the neighbour closest to the destination by straight-line distance is chosen). Movement is capped at 35% of the segment to limit prediction error. When real data arrives confirming departure, the blend mechanism smoothly corrects the position. At terminal stations (where the train's destination matches its current station), predicted departure is skipped entirely since the train will reverse direction.
