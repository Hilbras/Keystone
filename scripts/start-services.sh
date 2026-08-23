: "${BOLD:=\033[1m}"
: "${RESET:=\033[0m}"
: "${GREEN:=\033[32m}"
: "${YELLOW:=\033[33m}"
: "${RED:=\033[31m}"
: "${GRAY:=\033[90m}"

set -euo pipefail

# Start Keystone dependencies (PostgreSQL + Redis) via Docker if available.
# Falls back to printing instructions when Docker is not installed.

POSTGRES_CONTAINER="keystone-postgres"
REDIS_CONTAINER="keystone-redis"

if ! command -v docker >/dev/null 2>&1; then
  echo ""
  echo -e "${YELLOW}${BOLD}⚠️  Docker is not installed.${RESET} Keystone needs PostgreSQL and Redis to run."
  echo "   Install Docker and run:"
  echo "     docker compose up -d"
  echo "   Or install PostgreSQL and Redis manually."
  echo ""
  exit 1
fi

# Determine the best way to invoke docker:
# 1. Plain docker (user already in docker group)
# 2. sg docker (user added to group but shell hasn't reloaded)
# 3. sudo docker (user has sudo access)
DOCKER_CMD=""
if docker ps >/dev/null 2>&1; then
  DOCKER_CMD="docker"
elif command -v sg >/dev/null 2>&1 && sg docker -c "docker ps" >/dev/null 2>&1; then
  DOCKER_CMD="sg docker -c docker"
elif sudo -n docker ps >/dev/null 2>&1; then
  DOCKER_CMD="sudo docker"
else
  echo ""
  echo -e "${YELLOW}${BOLD}⚠️  Docker is installed but not accessible.${RESET}"
  echo "   Try one of the following:"
  echo "     - newgrp docker"
  echo "     - Log out and back in to apply the docker group"
  echo "     - Run this script with sudo"
  echo ""
  exit 1
fi

docker_exec() {
  if [ "$DOCKER_CMD" = "sg docker -c docker" ]; then
    # sg requires the whole command as a single quoted string.
    sg docker -c "docker $*"
  else
    $DOCKER_CMD "$@"
  fi
}

start_postgres() {
  if docker_exec ps --format '{{.Names}}' | grep -qx "${POSTGRES_CONTAINER}"; then
    echo -e "${GREEN}${BOLD}✅${RESET} PostgreSQL container is already running."
    return
  fi

  if docker_exec ps -a --format '{{.Names}}' | grep -qx "${POSTGRES_CONTAINER}"; then
    echo "==> Starting existing PostgreSQL container..."
    docker_exec start "${POSTGRES_CONTAINER}"
  else
    echo "==> Creating PostgreSQL container..."
    docker_exec run -d \
      --name "${POSTGRES_CONTAINER}" \
      -e POSTGRES_USER=hilbras \
      -e POSTGRES_PASSWORD=hilbras \
      -e POSTGRES_DB=hilbras \
      -p 5432:5432 \
      --health-cmd pg_isready \
      --health-interval 10s \
      --health-timeout 5s \
      --health-retries 5 \
      postgres:16
  fi
}

start_redis() {
  if docker_exec ps --format '{{.Names}}' | grep -qx "${REDIS_CONTAINER}"; then
    echo -e "${GREEN}${BOLD}✅${RESET} Redis container is already running."
    return
  fi

  if docker_exec ps -a --format '{{.Names}}' | grep -qx "${REDIS_CONTAINER}"; then
    echo "==> Starting existing Redis container..."
    docker_exec start "${REDIS_CONTAINER}"
  else
    echo "==> Creating Redis container..."
    docker_exec run -d \
      --name "${REDIS_CONTAINER}" \
      -p 6379:6379 \
      --health-cmd "redis-cli ping" \
      --health-interval 10s \
      --health-timeout 5s \
      --health-retries 5 \
      redis:7
  fi
}

start_postgres
start_redis

echo ""
echo "==> Waiting for services to be healthy..."
for i in {1..30}; do
  pg_status=$(docker_exec inspect --format='{{.State.Health.Status}}' "${POSTGRES_CONTAINER}" 2>/dev/null || echo "unhealthy")
  redis_status=$(docker_exec inspect --format='{{.State.Health.Status}}' "${REDIS_CONTAINER}" 2>/dev/null || echo "unhealthy")
  if [ "${pg_status}" = "healthy" ] && [ "${redis_status}" = "healthy" ]; then
    echo -e "${GREEN}${BOLD}✅${RESET} PostgreSQL and Redis are ready."
    echo ""
    exit 0
  fi
  sleep 1
done

echo -e "${YELLOW}${BOLD}⚠️${RESET}  Services did not become healthy within 30 seconds."
echo "   Check with: ${DOCKER_CMD} logs ${POSTGRES_CONTAINER} / ${REDIS_CONTAINER}"
echo ""
exit 1
