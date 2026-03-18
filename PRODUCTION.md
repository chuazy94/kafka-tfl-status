# Production Deployment Guide

## Production Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ORACLE CLOUD (Always Free VM)                       │
│                    4 ARM Ampere cores · 24GB RAM · 200GB                   │
│                                                                            │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────────┐  │
│  │  Kafka           │    │  Python Producer  │    │  PySpark Consumer    │  │
│  │  (Docker)        │◄───│  (Docker)         │    │  (Docker)            │  │
│  │                  │    │                   │    │                      │  │
│  │  Topic:          │    │  Polls TfL        │    │  Reads from Kafka    │  │
│  │  tube-prediction │    │  TrackerNet API   │    │  Parses XML          │  │
│  │  -timings-topic  │───►│  every 30s        │    │  Writes to PG        │  │
│  │                  │    │                   │    │                      │  │
│  │  ~1GB RAM        │    │  ~100MB RAM       │    │  ~1.5GB RAM          │  │
│  └─────────────────┘    └──────────────────┘    └──────────┬───────────┘  │
│                                                             │              │
│  ┌──────────────────────────────────────────────────────────▼───────────┐  │
│  │  PostgreSQL 16 + PostGIS (Docker)                                    │  │
│  │  Port 5432 (exposed for Vercel)                                      │  │
│  │                                                                      │  │
│  │  Tables: stations, lines, station_adjacency, train_positions         │  │
│  │  View: latest_train_positions                                        │  │
│  │  ~4GB RAM                                                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Total: ~7GB / 24GB available                                              │
└──────────────────────────────────────────────────────────────┬─────────────┘
                                                               │
                                               SQL query over internet
                                               (port 5432, SSL optional)
                                                               │
               ┌──────────────────────┐              ┌─────────▼──────────┐
               │  Vercel              │              │  Vercel             │
               │  /api/trains         │──────────────│  /api/lines         │
               │  /api/stations       │              │  /api/stations      │
               │  (Serverless Fns)    │              │  (SSR/ISR)          │
               └──────────┬──────────┘              └─────────────────────┘
                          │
                          │ JSON (GeoJSON)
                          ▼
               ┌─────────────────────┐
               │  Browser            │
               │  Next.js + Mapbox   │
               │  (Client-side)      │
               │                     │
               │  Polls /api/trains  │
               │  every 30 seconds   │
               │  Dead-reckoning     │
               │  animation          │
               └─────────────────────┘
```

## Services & Free Tiers

| Service | Purpose | Free Tier Limits | Notes |
|---------|---------|------------------|-------|
| **Oracle Cloud** | Kafka + Producer + PySpark + **PostgreSQL** | 4 ARM cores, 24GB RAM, 200GB disk, 10TB egress/month, **forever** | cloud.oracle.com |
| **Vercel** | Next.js frontend + API routes | 100GB bandwidth/month, 10s function timeout | vercel.com |
| **Mapbox** | Map tiles | 50,000 map loads/month | mapbox.com |
| **TfL API** | Train data source | Unlimited (with API key) | api.tfl.gov.uk |

**Total cost: $0/month**

---

## Step-by-Step Deployment

### Step 1: Set Up Oracle Cloud VM

1. Create a free account at [cloud.oracle.com](https://cloud.oracle.com)
2. Create an **Ampere A1** instance (Always Free eligible):
   - Shape: `VM.Standard.A1.Flex`
   - OCPUs: 2 (of 4 available)
   - Memory: 12GB (of 24 available — keep headroom)
   - OS: Ubuntu 22.04 (or Oracle Linux)
   - Storage: 50GB boot volume
3. Configure the **Security List** (firewall):
   - Allow outbound traffic (for TfL API, Docker Hub)
   - Allow inbound **TCP port 5432** from Vercel's IP ranges (for PostgreSQL)
   - Alternatively, allow 5432 from `0.0.0.0/0` and rely on PostgreSQL's `pg_hba.conf` + strong password
4. SSH into the VM and install Docker:
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y docker.io docker-compose-plugin
   sudo usermod -aG docker $USER
   # Log out and back in for group change to take effect
   ```

### Step 2: Deploy the Pipeline to Oracle Cloud

1. Clone the repo onto the VM:
   ```bash
   git clone https://github.com/<your-username>/kafka-tfl-status.git
   cd kafka-tfl-status
   ```

2. Create a `.env.prod` file on the VM:
   ```bash
   # TfL API
   TFL_APP_KEY=<your-tfl-api-key>

   # PostgreSQL (used by PySpark consumer — overridden to local in docker-compose)
   POSTGRES_USER=tfl
   POSTGRES_PASSWORD=<strong-password-here>
   POSTGRES_DB=tfl_trains
   ```

3. Start the pipeline:
   ```bash
   docker compose -f kafka_config/docker-compose.prod.yml up -d
   ```

4. Wait for PostgreSQL to initialise, then import station data and adjacency graph:
   ```bash
   # Run the import scripts against the local PostgreSQL
   POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=tfl \
     POSTGRES_PASSWORD=<password> POSTGRES_DB=tfl_trains \
     python scripts/import_stations.py

   POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=tfl \
     POSTGRES_PASSWORD=<password> POSTGRES_DB=tfl_trains \
     python scripts/build_adjacency.py
   ```

5. Verify it's running:
   ```bash
   docker compose -f kafka_config/docker-compose.prod.yml logs -f
   ```

### Step 3: Deploy Next.js to Vercel

1. Push your repo to GitHub
2. Go to [vercel.com](https://vercel.com) and import the repository
3. Set the **Root Directory** to `web_app`
4. Add environment variables in Vercel's dashboard:
   ```
   DATABASE_URL=postgresql://tfl:<password>@<oracle-vm-public-ip>:5432/tfl_trains
   NEXT_PUBLIC_MAPBOX_TOKEN=<your-mapbox-token>
   ```
5. Deploy — Vercel will auto-build and serve the Next.js app

### Step 4: Secure Mapbox Token

1. Go to [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens)
2. Edit your public token
3. Under **URL restrictions**, add your Vercel domain:
   ```
   https://your-app.vercel.app
   ```
4. This prevents token theft — the token will only work from your domain

---

## Configuration Changes Required

### PostgreSQL Security (Oracle VM)

Since PostgreSQL is now exposed to the internet, secure it:

1. Use a **strong password** (not the default `tfl_password`)
2. Optionally restrict access in `pg_hba.conf` to Vercel's IP ranges
3. Consider setting up SSL certificates for the PostgreSQL connection

### Kafka Listeners (Production)

In production, Kafka only needs internal listeners since the producer and consumer are on the same VM:

```yaml
KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
```

Remove the `PLAINTEXT_HOST` listener (port 9094) — it was only needed for host-to-container access during local development.

---

## Database Storage Management

Oracle VM gives 50-200GB of disk. Train positions grow at ~150 bytes/row × ~4M rows/day ≈ 600MB/day.

The cleanup job runs every hour and retains the last 24 hours of data (~600MB). This is well within the disk limits.

If you want longer retention for analytics, you have plenty of disk space on the Oracle VM — increase the retention interval in the db-cleanup service.

---

## Monitoring & Maintenance

### Health Checks

SSH into the Oracle VM periodically or set up a simple monitoring script:

```bash
# Check all containers are running
docker compose -f kafka_config/docker-compose.prod.yml ps

# Check Kafka topic has recent messages
docker exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic tube-prediction-timings-topic \
  --max-messages 1 --timeout-ms 5000

# Check PySpark is writing to PostgreSQL
docker logs --tail 20 pyspark-streaming

# Check PostgreSQL directly
docker exec tfl-postgres psql -U tfl -d tfl_trains -c "SELECT COUNT(*) FROM train_positions WHERE timestamp > NOW() - INTERVAL '5 minutes';"
```

### Auto-Restart on VM Reboot

Ensure Docker starts on boot and containers restart automatically:

```bash
sudo systemctl enable docker

# docker-compose.prod.yml already has `restart: unless-stopped` on all services
```

---

## Cost Summary

| Service | Monthly Cost | Limit to Watch |
|---------|-------------|----------------|
| Oracle Cloud VM | **$0** | Don't accidentally upgrade the instance shape |
| Vercel | **$0** | 100GB bandwidth — ~5-10KB per API call, fine for moderate traffic |
| Mapbox | **$0** | 50,000 map loads/month — restrict token to your domain |
| TfL API | **$0** | Register for an API key at api.tfl.gov.uk |
| **Total** | **$0/month** | |
