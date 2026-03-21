#!/usr/bin/env bash
set -e

REPO="https://github.com/jonesfernandess/clink.git"
INSTALL_DIR="$HOME/.clink"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${GREEN}  ✓${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${RESET} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${RESET} %s\n" "$1"; exit 1; }
step()  { printf "\n${BOLD}  ▸ %s${RESET}\n" "$1"; }

echo ""
echo -e "${BOLD}  ╔═══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}  ║           ${YELLOW}CLINK${RESET}${BOLD} — Installer            ║${RESET}"
echo -e "${BOLD}  ║   ${DIM}Claude Linked to Telegram${RESET}${BOLD}            ║${RESET}"
echo -e "${BOLD}  ╚═══════════════════════════════════════╝${RESET}"
echo ""

# Check Node.js
step "Checking Node.js..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node.js >= 18 first: https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js >= 18 required (found v$(node -v | sed 's/v//'))"
fi
info "Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
info "npm $(npm -v)"

# Check Claude Code CLI
step "Checking Claude Code CLI..."
if command -v claude &>/dev/null; then
  info "Claude Code CLI found"
else
  warn "Claude Code CLI not found — install it with: npm install -g @anthropic-ai/claude-code"
fi

# Clone or update
step "Installing Clink..."
if [ -d "$INSTALL_DIR" ]; then
  warn "Existing installation found at $INSTALL_DIR"
  cd "$INSTALL_DIR"
  git pull origin main --quiet
  info "Updated to latest version"
else
  git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  info "Cloned to $INSTALL_DIR"
fi

# Install dependencies
step "Installing dependencies..."
npm install --silent 2>/dev/null
info "Dependencies installed"

# Install globally
step "Installing globally..."
npm install -g . --silent 2>/dev/null
info "Installed globally — 'clink' command available"

# Done
echo ""
echo -e "${GREEN}${BOLD}  ✓ Clink installed successfully!${RESET}"
echo ""
echo -e "  ${DIM}Run the setup wizard:${RESET}"
echo -e "  ${YELLOW}\$ clink onboard${RESET}"
echo ""
