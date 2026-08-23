: "${BOLD:=\033[1m}"
: "${RESET:=\033[0m}"
: "${GREEN:=\033[32m}"
: "${YELLOW:=\033[33m}"
: "${RED:=\033[31m}"
: "${BLUE:=\033[34m}"
: "${CYAN:=\033[36m}"
: "${GRAY:=\033[90m}"

# If Docker is installed but this shell cannot use it, re-run this script with the
# docker group applied (via sg). This avoids forcing the user to run newgrp manually.
if command -v docker >/dev/null 2>&1 && [ -z "${KEYSTONE_DOCKER_REEXEC:-}" ]; then
  if ! docker ps >/dev/null 2>&1; then
    if command -v sg >/dev/null 2>&1 && sg docker -c "docker ps" >/dev/null 2>&1; then
      KEYSTONE_DOCKER_REEXEC=1
      args=""
      if [ $# -gt 0 ]; then
        args=" $(printf "%q" "$*")"
      fi
      exec sg docker -c "bash -c 'cd $(printf "%q" "$PWD") && $(printf "%q" "$0")$args'"
    fi
  fi
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=scripts/ui.sh
source "${SCRIPT_DIR}/scripts/ui.sh"

# Kill any stale Keystone backend/frontend processes so repeated starts do not
# leak memory or leave port 4001/5173 in use.
kill_stale_keystone() {
  pids=$(ps -eo pid,args | grep -E '(tsx watch src/(index|setup-server)\.ts|node dist/(index|setup-server)\.js|frontend/node_modules/.bin/vite)' | grep -v grep | awk '{print $1}' || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}
kill_stale_keystone

# Load environment variables if .env exists
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# Default ports
export PORT="${PORT:-4001}"
export KEYSTONE_API_URL="${KEYSTONE_API_URL:-http://localhost:${PORT}}"

ui_header "Hilbras Keystone Launcher" "Starting the identity platform"

# Resolve a working Docker invocation for this shell session.
resolve_docker_cmd() {
  if docker ps >/dev/null 2>&1; then
    echo "docker"
  elif command -v sg >/dev/null 2>&1 && sg docker -c "docker ps" >/dev/null 2>&1; then
    echo "sg docker -c docker"
  elif sudo -n docker ps >/dev/null 2>&1; then
    echo "sudo docker"
  else
    echo ""
  fi
}

DOCKER_CMD="$(resolve_docker_cmd)"

# Check whether the dependency containers are running and offer to start them.
check_and_start_services() {
  if [ "$DOCKER_CMD" = "sg docker -c docker" ]; then
    DOCKER_PS_CMD="sg docker -c 'docker ps --format \"{{.Names}}\"'"
  else
    DOCKER_PS_CMD="$DOCKER_CMD ps --format '{{.Names}}'"
  fi

  if eval "$DOCKER_PS_CMD" 2>/dev/null | grep -qx "keystone-postgres" && \
     eval "$DOCKER_PS_CMD" 2>/dev/null | grep -qx "keystone-redis"; then
    ui_success "PostgreSQL and Redis containers are running."
  else
    ui_warning "PostgreSQL and/or Redis containers are not running."
    if ui_confirm "Start PostgreSQL and Redis now?"; then
      ./scripts/start-services.sh || true
    else
      ui_info "Continuing without starting services. You can enter external URLs in the wizard."
    fi
  fi
}

# Service status checks
ui_step "Checking dependencies..."
if command -v docker >/dev/null 2>&1; then
  if [ -n "$DOCKER_CMD" ]; then
    check_and_start_services
  else
    if ui_confirm "Docker is installed but not accessible. Run Docker commands with sudo?"; then
      sudo -v || true
      if sudo -n docker ps >/dev/null 2>&1; then
        DOCKER_CMD="sudo docker"
        check_and_start_services
      else
        ui_error "Could not authenticate sudo. Start the containers manually or log out and back in."
      fi
    else
      ui_warning "Docker is installed but not accessible in this shell."
      ui_info "Try: newgrp docker   or   log out and back in   then run ./start.sh again."
    fi
  fi
else
  ui_warning "Docker is not installed. PostgreSQL and Redis must be running manually."
fi

# Detect whether we are in first-run setup mode.
# Stay in setup mode until .env exists AND the owner has been created.
SETUP_MARKER=".keystone-setup-complete"

# Production mode uses the compiled dist/ build and less memory.
# Usage: ./start.sh --production
USE_PRODUCTION=false
for arg in "$@"; do
  if [ "$arg" = "--production" ]; then
    USE_PRODUCTION=true
  fi
done

if [ -f .env ] && [ -f "$SETUP_MARKER" ]; then
  if [ "$USE_PRODUCTION" = "true" ] && [ -f dist/index.js ]; then
    BACKEND_COMMAND="node dist/index.js"
  else
    BACKEND_COMMAND="npx tsx watch src/index.ts"
  fi
  BACKEND_LABEL="backend API"
else
  export KEYSTONE_SETUP_MODE="true"
  if [ "$USE_PRODUCTION" = "true" ] && [ -f dist/setup-server.js ]; then
    BACKEND_COMMAND="node dist/setup-server.js"
  else
    BACKEND_COMMAND="npx tsx watch src/setup-server.ts"
  fi
  BACKEND_LABEL="setup server"
fi

cleanup() {
  echo ""
  ui_step "Shutting down Keystone services..."
  if [ -n "${BACKEND_PID:-}" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "${FRONTEND_PID:-}" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  ui_success "Done."
}
trap cleanup INT TERM EXIT

echo ""
ui_step "Starting Keystone ${BACKEND_LABEL} on port ${PORT}..."
${BACKEND_COMMAND} &
BACKEND_PID=$!

ui_info "Waiting for backend health check..."
if ui_wait_for_url "http://localhost:${PORT}/health" 60; then
  ui_success "Keystone backend is ready."
else
  ui_warning "Backend health check timed out. The frontend may show temporary errors."
fi

echo ""
if [ "$USE_PRODUCTION" = "true" ] && [ -f frontend/dist/index.html ]; then
  ui_step "Starting Keystone production frontend preview..."
  cd frontend
  VITE_KEYSTONE_API_URL="${KEYSTONE_API_URL}" npx vite preview --port 5173 --strictPort &
  FRONTEND_PID=$!
  FRONTEND_MODE="production"
else
  ui_step "Starting Keystone setup frontend..."
  cd frontend
  VITE_KEYSTONE_API_URL="${KEYSTONE_API_URL}" npm run dev &
  FRONTEND_PID=$!
  FRONTEND_MODE="development"
fi

cd "$SCRIPT_DIR"

ui_divider
echo ""
ui_success "Keystone is starting up:"
echo ""
echo -e "  ${BOLD}API:${RESET}      http://localhost:${PORT}"
echo -e "  ${BOLD}UI:${RESET}       http://localhost:5173"
if [ "$FRONTEND_MODE" = "production" ]; then
  echo -e "  ${BOLD}Mode:${RESET}     production (compiled static files)"
else
  echo -e "  ${BOLD}Mode:${RESET}     development (hot reload)"
fi
echo ""
if [ -n "${KEYSTONE_SETUP_MODE:-}" ]; then
  ui_warning "Setup mode active."
  ui_info "Copy the setup token from the server logs and paste it into the wizard."
  echo ""
fi
echo -e "  ${GRAY}Press Ctrl+C to stop both services.${RESET}"
echo ""

# Keep the backend alive. If it exits cleanly and setup has completed, restart it
# in normal (non-setup) mode so the user does not have to run ./start.sh again.
while true; do
  wait "$BACKEND_PID"
  backend_exit=$?
  if [ -f "$SETUP_MARKER" ] && [ "$backend_exit" -eq 0 ]; then
    echo ""
    ui_step "Setup complete. Restarting Keystone in normal mode..."
    if [ "$USE_PRODUCTION" = "true" ] && [ -f dist/index.js ]; then
      BACKEND_COMMAND="node dist/index.js"
    else
      BACKEND_COMMAND="npx tsx watch src/index.ts"
    fi
    $BACKEND_COMMAND &
    BACKEND_PID=$!
    ui_info "Waiting for backend health check..."
    if ui_wait_for_url "http://localhost:${PORT}/health" 60; then
      ui_success "Keystone backend is ready."
    else
      ui_warning "Backend health check timed out."
    fi
  else
    break
  fi
done

wait
