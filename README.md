# arduino-mcp

> Arduino IDE & ESP32/Arduino board control via Model Context Protocol (MCP)

Claude Code (or any MCP-compatible AI) can write, compile, upload, and monitor Arduino sketches directly — no manual IDE interaction needed.

## Features

- 🔍 **Auto board detection** — automatically finds upload and monitor ports (handles ESP32-S3's dual USB setup)
- 💾 **Board memory** — remembers your board's FQBN, ports, flash size, PSRAM after first detection
- 📤 **One-command deploy** — compile + upload in a single `compile_and_upload` call
- 🔓 **Auto port unlock** — frees busy serial ports before uploading (no more "port is busy" errors)
- 📡 **Serial monitor** — read serial output directly from Claude
- 📚 **Library & board management** — install libraries and board packages
- 🖥️ **IDE integration** — open Arduino IDE with a specific sketch

## Requirements

- [arduino-cli](https://arduino.github.io/arduino-cli/) installed and on `$PATH`
- Node.js 18+
- Linux (tested on Ubuntu 24.04)

## Installation

```bash
# Clone
git clone https://github.com/birusk/arduino-mcp
cd arduino-mcp

# Install dependencies & build
npm install
npm run build

# Add to Claude Code (user-wide)
claude mcp add arduino-mcp --scope user -- node /absolute/path/to/arduino-mcp/dist/index.js
```

## Quick Start

Once added to Claude Code, just talk to it:

```
"ESP32 kartımı tanı"          → detect_board
"blink sketch oluştur"        → create_sketch
"blink sketch'ini yükle"      → compile_and_upload
"serial monitörden oku"       → serial_monitor
"DHT11 kütüphanesini kur"     → install_library
```

## Tools

| Tool | Description |
|------|-------------|
| `detect_board` | Auto-detect connected board, save ports & FQBN |
| `board_config` | Show or update saved board settings |
| `list_boards` | List connected boards and ports |
| `list_sketches` | List sketches in ~/Arduino |
| `create_sketch` | Create a new sketch |
| `read_sketch` | Read sketch source code |
| `write_sketch` | Update sketch source code |
| `compile_sketch` | Compile a sketch |
| `upload_sketch` | Upload compiled sketch to board |
| `compile_and_upload` | Compile + upload in one step |
| `serial_monitor` | Read serial output from board |
| `install_board` | Install board platform (e.g. esp32:esp32) |
| `install_library` | Install an Arduino library |
| `search_library` | Search the Arduino library index |
| `open_arduino_ide` | Open Arduino IDE (optionally with a sketch) |
| `board_info` | Show detailed board info |
| `arduino_cli_check` | Check arduino-cli installation |

## ESP32-S3 Dual USB

ESP32-S3 boards have two USB ports:

| Port | Purpose |
|------|---------|
| **COM / UART** (CH343 chip) | Upload sketches |
| **USB** (native ESP32-S3) | Serial monitor |

`detect_board` handles this automatically — it identifies each port's role and saves both.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCHES_DIR` | `~/Arduino` | Sketches directory |
| `ARDUINO_IDE_PATH` | `~/Applications/arduino-ide*.AppImage` | Arduino IDE path |

## Board Config File

Saved to `~/.arduino-mcp.json`:

```json
{
  "defaultBoard": "E8F60A89EE74",
  "boards": {
    "E8F60A89EE74": {
      "fqbn": "esp32:esp32:esp32s3",
      "uploadPort": "/dev/ttyACM1",
      "monitorPort": "/dev/ttyACM0",
      "cdcOnBoot": "default",
      "flashSize": "16M",
      "psram": "opi",
      "lastSeen": "2026-10-06T00:00:00.000Z"
    }
  }
}
```

## License

MIT