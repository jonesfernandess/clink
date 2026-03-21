<p align="center">
  <img src="assets/logo.svg" alt="CLINK" width="600"/>
</p>

<p align="center">
  <strong>Use Claude Code from your phone via Telegram.</strong>
</p>

Clink is a gateway that bridges [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and Telegram, allowing you to send prompts and receive responses directly from a Telegram chat. Run it on your machine and interact with Claude Code from anywhere — your phone, tablet, or any device with Telegram.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/jonesfernandess/clink/main/install.sh | bash
```

Then run the setup wizard:

```bash
clink onboard
```

## How It Works

```
You (Telegram) → Clink Gateway → Claude Code CLI → Response → You (Telegram)
```

1. You send a message to your Telegram bot
2. The gateway receives the message and forwards it to the Claude Code CLI
3. Claude Code processes the prompt in your configured working directory
4. The response is sent back to your Telegram chat

## Features

- **Remote access to Claude Code** — interact with your local dev environment from anywhere
- **User allowlist** — restrict access to specific Telegram user IDs
- **Model selection** — choose between Sonnet, Opus, and Haiku
- **Custom working directory** — point Claude to any project on your machine
- **System prompt** — add custom instructions to every request
- **Autonomous mode** — skip permission prompts for seamless mobile use
- **Multi-language** — English, Portuguese, and Spanish
- **Interactive CLI** — setup wizard and menu for easy configuration

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **Telegram bot token** from [@BotFather](https://t.me/BotFather)

## Installation

```bash
# Clone the repository
git clone https://github.com/jonesfernandess/clink.git
cd clink

# Install dependencies
npm install

# Install globally (optional — enables the clink command)
npm install -g .
```

## Setup

Run the setup wizard:

```bash
# If installed globally
clink onboard

# Or directly
node cli.js onboard
```

The wizard will guide you through:

1. **Language** — choose your preferred language
2. **Claude CLI check** — verifies installation and authentication
3. **Telegram token** — paste your bot token from @BotFather
4. **User allowlist** — add your Telegram user ID for security
5. **Model** — pick your preferred Claude model

## Usage

### Interactive Menu

```bash
clink
```

Opens a menu where you can start/stop the gateway, change settings, manage users, and more.

### CLI Commands

```bash
clink gateway     # Start the gateway (foreground)
clink start       # Alias for gateway
clink stop        # Stop a running gateway
clink restart     # Restart the gateway
clink status      # Show gateway status
clink send        # Send a message or file to Telegram
clink onboard     # Run the setup wizard
clink update      # Update to latest version from main
clink help        # Show help
```

### Sending Messages & Files

```bash
clink send "hello world"             # Send text
clink send -f /path/to/file.png      # Send a file
clink send -f /path/to/doc.pdf "lg"  # File with caption
clink send                           # Interactive mode
```

When the gateway is running, files created or modified by Claude (via Write/Edit tools) are automatically sent to your Telegram chat.

## Configuration

All settings are stored at `~/.config/clink/config.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `token` | Telegram bot token | — |
| `allowedUsers` | Array of allowed Telegram user IDs | `[]` (all) |
| `model` | Claude model (`sonnet`, `opus`, `haiku`) | `sonnet` |
| `workingDir` | Directory where Claude Code runs | `~` |
| `skipPermissions` | Skip CLI permission prompts | `true` |
| `systemPrompt` | Custom instructions appended to every request | — |
| `language` | Interface language (`en`, `pt`, `es`) | `en` |

### Finding Your Telegram User ID

Start the gateway without any users in the allowlist, send a message to the bot, and check the terminal log — your user ID will appear in the output.

## Security

- **User allowlist**: Only listed Telegram user IDs can interact with the bot. If the list is empty, anyone who finds the bot can use it.
- **Autonomous mode**: When enabled (`skipPermissions: true`), Claude Code executes commands without asking for terminal approval. This is the recommended mode for mobile use, but make sure your allowlist is configured.

## License

ISC
