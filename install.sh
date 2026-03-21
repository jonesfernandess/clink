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

# Install audio transcription dependencies
step "Installing audio transcription dependencies..."

# ffmpeg
if command -v ffmpeg &>/dev/null; then
  info "ffmpeg already installed"
else
  if [[ "$(uname)" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install ffmpeg --quiet
      info "ffmpeg installed via Homebrew"
    else
      warn "Homebrew not found — install ffmpeg manually: https://ffmpeg.org"
    fi
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y ffmpeg -qq
    info "ffmpeg installed via apt"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y ffmpeg -q
    info "ffmpeg installed via dnf"
  else
    warn "Could not install ffmpeg automatically — install it manually"
  fi
fi

# Python3
if command -v python3 &>/dev/null; then
  info "Python3 $(python3 --version | cut -d' ' -f2)"
else
  if [[ "$(uname)" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install python3 --quiet
      info "Python3 installed via Homebrew"
    else
      warn "Homebrew not found — install Python3 manually: https://python.org"
    fi
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y python3 python3-pip -qq
    info "Python3 installed via apt"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y python3 python3-pip -q
    info "Python3 installed via dnf"
  else
    warn "Could not install Python3 automatically — install it manually"
  fi
fi

# faster-whisper
if command -v python3 &>/dev/null; then
  if python3 -c "import faster_whisper" &>/dev/null; then
    info "faster-whisper already installed"
  else
    pip3 install faster-whisper --quiet 2>/dev/null || python3 -m pip install faster-whisper --quiet 2>/dev/null
    if python3 -c "import faster_whisper" &>/dev/null; then
      info "faster-whisper installed via pip"
    else
      warn "Could not install faster-whisper — run: pip3 install faster-whisper"
    fi
  fi
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

# Build TypeScript
step "Building TypeScript..."
npm run build 2>/dev/null
info "Build complete"

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
