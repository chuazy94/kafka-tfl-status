## Overview

TFL Tube Predictions streaming pipeline using Kafka and PySpark, with a Next.js visualization frontend.

## Architecture

See `architecture.md` for detailed diagram. Pipeline flow:
1. **Ingest** - Python Kafka producer polls TfL TrackerNet API every 30s
2. **Buffer** - Kafka cluster buffers messages in `tube-prediction-timings-topic`
3. **Process** - PySpark Streaming reads from Kafka, parses XML, transforms to JSON, writes to Snowflake

## Repo Structure

```
kafka_producer/      # Python Kafka producer (TfL API → Kafka)
pyspark_streaming/   # PySpark consumer (Kafka → Snowflake)
kafka_config/        # Docker Compose for Kafka cluster, init SQL
web_app/             # Next.js frontend for train visualization
scripts/             # Utility scripts (station import, adjacency build)
```

## Frameworks & Stack

| Component | Tech |
|-----------|------|
| Producer | Python, kafka-python |
| Streaming | PySpark 4.0 |
| Message Queue | Kafka (Docker) |
| Database | PostgreSQL, Snowflake |
| Frontend | Next.js 15, React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Maps | Mapbox GL |

## Coding Practices

- **Python**: snake_case for variables/functions, follow PEP 8
- **TypeScript**: camelCase for variables/functions, PascalCase for components
- **Commits**: Use conventional commit messages (`feat:`, `fix:`, `refactor:`)
- **Environment**: Use `.env` files for secrets, never commit credentials
- **Types**: Prefer explicit types over `any` in TypeScript
