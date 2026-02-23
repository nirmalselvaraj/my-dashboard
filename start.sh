#!/usr/bin/env zsh

REDIS_BIN="$HOME/redis-build/redis-stable/src/redis-server"
REDIS_CLI="$HOME/redis-build/redis-stable/src/redis-cli"
REDIS_LOG="$HOME/redis-build/redis.log"
DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo "${CYAN}[dashboard]${RESET} $*"; }
success() { echo "${GREEN}[dashboard]${RESET} $*"; }
warn()    { echo "${YELLOW}[dashboard]${RESET} $*"; }
error()   { echo "${RED}[dashboard]${RESET} $*"; }

echo ""
echo "${BOLD}  MY DASHBOARD — startup${RESET}"
echo "  ─────────────────────────────"
echo ""

# ── Load nvm ──────────────────────────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v node &>/dev/null; then
  error "node not found. Run: source ~/.nvm/nvm.sh"
  exit 1
fi

# ── Start Redis ───────────────────────────────────────────────────────────
if $REDIS_CLI ping &>/dev/null 2>&1; then
  warn "Redis already running — skipping"
else
  info "Starting Redis..."
  $REDIS_BIN --daemonize yes --logfile "$REDIS_LOG" --port 6379
  sleep 1
  if $REDIS_CLI ping &>/dev/null 2>&1; then
    success "Redis started  (port 6379)"
  else
    error "Redis failed to start. Check log: $REDIS_LOG"
    exit 1
  fi
fi

# ── Start Dashboard ───────────────────────────────────────────────────────
info "Starting dashboard..."
cd "$DASHBOARD_DIR"
node server.js &
NODE_PID=$!

sleep 2
if kill -0 $NODE_PID 2>/dev/null; then
  success "Dashboard started (pid $NODE_PID)  →  http://localhost:3000"
else
  error "Dashboard failed to start"
  exit 1
fi

echo ""
echo "  ${GREEN}✓${RESET} All services running"
echo "  ${GREEN}✓${RESET} Open ${BOLD}http://localhost:3000${RESET}"
echo ""
echo "  Press ${BOLD}Ctrl+C${RESET} to stop everything"
echo ""

# ── Graceful shutdown on Ctrl+C ───────────────────────────────────────────
cleanup() {
  echo ""
  info "Shutting down..."
  kill $NODE_PID 2>/dev/null && success "Dashboard stopped"
  $REDIS_CLI shutdown nosave 2>/dev/null && success "Redis stopped"
  echo ""
  exit 0
}
trap cleanup INT TERM

# Keep script alive (node runs in background)
wait $NODE_PID
