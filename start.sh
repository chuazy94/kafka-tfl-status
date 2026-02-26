#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WEBAPP_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    [[ -n "$WEBAPP_PID" ]] && kill "$WEBAPP_PID" 2>/dev/null && echo "Stopped web app"
    echo -e "${GREEN}Web app stopped. Docker services still running.${NC}"
    echo -e "Run './start.sh down' to stop all Docker services."
    exit 0
}

trap cleanup SIGINT SIGTERM

case "${1:-up}" in
    up)
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN}  TfL Tube Predictions Pipeline${NC}"
        echo -e "${GREEN}========================================${NC}"
        
        echo -e "\n${YELLOW}Starting Docker services...${NC}"
        docker compose -f kafka_config/docker-compose.yml up -d --build
        
        echo -e "\n${YELLOW}Starting Next.js web app...${NC}"
        cd web_app
        npm run dev &
        WEBAPP_PID=$!
        cd "$SCRIPT_DIR"
        
        echo -e "\n${GREEN}========================================${NC}"
        echo -e "${GREEN}  All services started!${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo -e "  Kafka UI:    http://localhost:8080"
        echo -e "  Web App:     http://localhost:3000"
        echo -e "\n  Press Ctrl+C to stop web app"
        echo -e "  Run './start.sh down' to stop Docker"
        echo -e "${GREEN}========================================${NC}\n"
        
        wait
        ;;
    down)
        echo -e "${YELLOW}Stopping all Docker services...${NC}"
        docker compose -f kafka_config/docker-compose.yml down
        echo -e "${GREEN}All services stopped.${NC}"
        ;;
    logs)
        docker compose -f kafka_config/docker-compose.yml logs -f "${2:-}"
        ;;
    *)
        echo "Usage: $0 {up|down|logs [service]}"
        echo "  up    - Start all services"
        echo "  down  - Stop all Docker services"
        echo "  logs  - Follow logs (optionally specify service)"
        exit 1
        ;;
esac
