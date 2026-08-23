: "${BOLD:=\033[1m}"
: "${RESET:=\033[0m}"
: "${GREEN:=\033[32m}"
: "${YELLOW:=\033[33m}"
: "${RED:=\033[31m}"
: "${BLUE:=\033[34m}"
: "${CYAN:=\033[36m}"
: "${GRAY:=\033[90m}"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=scripts/ui.sh
source "${SCRIPT_DIR}/scripts/ui.sh"

ui_header "Hilbras Keystone Installer" "One-command setup for the identity platform"

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    ui_success "Docker is already installed."
    return 0
  fi

  echo ""
  ui_warning "Docker is not installed."
  if ! ui_confirm "Install Docker automatically using the official Docker script?"; then
    ui_info "Skipping Docker installation. You will need PostgreSQL and Redis running manually."
    return 1
  fi

  ui_step "Installing Docker..."
  ui_info "This uses the official Docker convenience script (https://get.docker.com)."
  ui_info "You may be prompted for your sudo password."
  echo ""

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://get.docker.com | sh
  else
    ui_error "curl or wget is required to install Docker. Please install Docker manually."
    exit 1
  fi

  if command -v systemctl >/dev/null 2>&1; then
    ui_step "Starting Docker service..."
    sudo systemctl start docker || true
    sudo systemctl enable docker || true
  elif command -v service >/dev/null 2>&1; then
    ui_step "Starting Docker service..."
    sudo service docker start || true
  fi

  if command -v usermod >/dev/null 2>&1; then
    ui_step "Adding user to docker group..."
    sudo usermod -aG docker "${USER}" || true
    echo ""
    ui_warning "You have been added to the docker group."
    ui_info "Log out and back in (or run 'newgrp docker') for this to take full effect."
  fi

  ui_success "Docker installation complete."
  return 0
}

ui_step "Installing backend dependencies..."
npm install
ui_success "Backend dependencies installed."

echo ""
ui_step "Installing frontend dependencies..."
cd frontend
npm install
ui_success "Frontend dependencies installed."

echo ""
wait_for_apt_lock() {
  local timeout="${1:-120}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if ! lsof /var/lib/dpkg/lock-frontend >/dev/null 2>&1 && \
       ! lsof /var/lib/apt/lists/lock >/dev/null 2>&1 && \
       ! lsof /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    if [ $elapsed -eq 0 ]; then
      ui_info "Waiting for another package manager process to finish..."
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

echo ""
ui_step "Installing Playwright Chromium for E2E tests..."
if wait_for_apt_lock 120; then
  if npx playwright install --with-deps chromium; then
    ui_success "Playwright Chromium installed."
  else
    ui_warning "Playwright system dependency installation failed."
    ui_info "You can install browsers later with: npx playwright install --with-deps chromium"
  fi
else
  ui_warning "Another apt/dpkg process is still running after 2 minutes."
  ui_info "Skipping Playwright system dependencies. Install later with:"
  ui_info "  npx playwright install --with-deps chromium"
fi

cd "$SCRIPT_DIR"

echo ""
install_docker

echo ""
ui_step "Starting PostgreSQL and Redis (via Docker)..."
if ./scripts/start-services.sh; then
  ui_success "PostgreSQL and Redis are ready."
else
  ui_warning "Could not start PostgreSQL/Redis automatically."
  ui_info "Start them manually and use the setup wizard to enter their URLs."
fi

ui_divider
echo ""
ui_success "Installation complete!"
echo ""
ui_info "Next steps:"
echo "  1. If Docker was just installed, log out and back in (or run 'newgrp docker')."
echo "  2. Start Keystone: ./start.sh"
echo "  3. Open http://localhost:5173 and complete the browser setup wizard."
echo "  4. Copy the setup token from the terminal when prompted."
echo ""
