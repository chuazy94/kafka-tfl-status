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
