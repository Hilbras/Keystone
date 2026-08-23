: "${BOLD:=\033[1m}"
: "${RESET:=\033[0m}"
: "${GREEN:=\033[32m}"
: "${YELLOW:=\033[33m}"
: "${RED:=\033[31m}"
: "${BLUE:=\033[34m}"
: "${CYAN:=\033[36m}"
: "${GRAY:=\033[90m}"

ui_header() {
  echo ""
  echo -e "${CYAN}${BOLD}╔════════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}${BOLD}║${RESET}  $1"
  printf "${CYAN}${BOLD}║${RESET}  %s${CYAN}${BOLD}%s${RESET}\n" "$(printf '%-58s' "$2")" ""
  echo -e "${CYAN}${BOLD}╚════════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
}

ui_step() {
  echo -e "${BLUE}${BOLD}==>${RESET} ${BOLD}$1${RESET}"
}

ui_success() {
  echo -e "${GREEN}${BOLD}✅${RESET} $1"
}

ui_warning() {
  echo -e "${YELLOW}${BOLD}⚠️${RESET}  $1"
}

ui_error() {
  echo -e "${RED}${BOLD}❌${RESET} $1"
}

ui_info() {
  echo -e "${GRAY}ℹ️  $1${RESET}"
}

ui_divider() {
  echo -e "${GRAY}────────────────────────────────────────────────────────────────${RESET}"
}

ui_confirm() {
  local prompt="$1"
  local default="${2:-y}"
  local answer
  while true; do
    if [ "$default" = "y" ]; then
      read -rp "$(echo -e "${YELLOW}?${RESET} $prompt [Y/n]: ")" answer
      answer="${answer:-Y}"
    else
      read -rp "$(echo -e "${YELLOW}?${RESET} $prompt [y/N]: ")" answer
      answer="${answer:-N}"
    fi
    case "$answer" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) echo "Please answer yes or no." ;;
    esac
  done
}

ui_prompt() {
  local prompt="$1"
  local default="$2"
  local answer
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${YELLOW}?${RESET} $prompt [$default]: ")" answer
    echo "${answer:-$default}"
  else
    read -rp "$(echo -e "${YELLOW}?${RESET} $prompt: ")" answer
    echo "$answer"
  fi
}

ui_spinner() {
  local pid=$1
  local message="$2"
  local delay=0.1
  local spinstr='|/-\\'
  while kill -0 "$pid" 2>/dev/null; do
    local temp=${spinstr#?}
    printf "\r${GRAY}%s [%s]${RESET}" "$message" "${spinstr:0:1}"
    local spinstr=$temp${spinstr:"$temp":1}
    sleep $delay
  done
  printf "\r%-70s\r" ""
}

ui_wait_for_url() {
  local url="$1"
  local timeout="${2:-60}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}
