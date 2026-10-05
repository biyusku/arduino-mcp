# arduino-mcp

> Arduino IDE & ESP32/Arduino board control via Model Context Protocol (MCP)

Claude Code (or any MCP client) can write, compile, upload, and monitor Arduino sketches — fully hands-free.

## Features

- 🔍 **Auto board detection** — finds upload and monitor ports automatically (handles ESP32-S3 dual-USB)
- 💾 **Board memory** — remembers FQBN, ports, flash, PSRAM after first `detect_board`
- 📤 **One-command deploy** — `compile_and_upload` does everything in one shot
- 🔓 **Auto port unlock** — frees busy serial ports before uploading
- 📡 **Serial monitor + send** — read and write serial without opening the IDE
- 📚 **Full library management** — install, uninstall, list, search, update
- 🌐 **OTA / WiFi upload** — upload over the air without a USB cable
- 🗂️ **Sketch management** — create (with templates), read, write, rename, delete
- ⚙️ **All FQBN options** — flash size, PSRAM, CDC on boot, partition scheme, upload speed
- 🖥️ **IDE launcher** — open Arduino IDE with a specific sketch

## Requirements

- [arduino-cli](https://arduino.github.io/arduino-cli/) on `$PATH`
- Node.js 18+
- Linux (tested Ubuntu 24.04) / macOS (untested)

## Installation

```bash
git clone https://github.com/birusk/arduino-mcp
cd arduino-mcp
npm install && npm run build

# Add to Claude Code (user-wide, works in any project)
claude mcp add arduino-mcp --scope user -- node /absolute/path/to/arduino-mcp/dist/index.js
```

## Quick Start

After restarting Claude Code, just talk naturally:

```
"kartımı tanı"                    → detect_board (auto-saves ports & FQBN)
"blink sketch oluştur"            → create_sketch (template: blink)
"blink'i derle ve yükle"          → compile_and_upload
"serial monitörden 5 saniye oku"  → serial_monitor
"karta 'LED_ON' gönder"           → send_serial
"DHT11 kütüphanesini kur"         → install_library
"kart ayarlarını göster"          → board_config show
```

## Tools (30 total)

### Board
| Tool | Description |
|------|-------------|
| `detect_board` | Auto-detect board, save ports & FQBN |
| `board_config` | Show or update saved board settings |
| `board_options` | List all FQBN options (flash, psram, cdc…) |
| `list_boards` | List connected boards with roles |
| `board_info` | Detailed board info (chip, MAC, revision) |
| `erase_flash` | Erase all flash memory |

### Sketch
| Tool | Description |
|------|-------------|
| `list_sketches` | List sketches with modification dates |
| `create_sketch` | Create sketch (templates: blink/wifi/mqtt/sensor/empty) |
| `read_sketch` | Read sketch source code |
| `write_sketch` | Write/update sketch source code |
| `delete_sketch` | Delete a sketch folder |
| `rename_sketch` | Rename a sketch |

### Compile & Upload
| Tool | Description |
|------|-------------|
| `compile_sketch` | Compile with error line:col formatting |
| `upload_sketch` | Upload (auto-unlocks busy port) |
| `compile_and_upload` | Compile + upload in one step ⭐ |
| `wifi_upload` | OTA upload over WiFi |

### Serial
| Tool | Description |
|------|-------------|
| `serial_monitor` | Read serial output |
| `send_serial` | Send data/command to board |
| `get_serial_ports` | List all ports with roles (upload/monitor) |

### Libraries & Platforms
| Tool | Description |
|------|-------------|
| `install_library` | Install library (with optional version) |
| `uninstall_library` | Uninstall a library |
| `list_libraries` | List installed libraries |
| `search_library` | Search Arduino library index |
| `update_libraries` | Update all installed libraries |
| `install_board` | Install board platform |
| `update_boards` | Update all board platforms |
| `list_installed_boards` | List installed platforms |

### IDE & CLI
| Tool | Description |
|------|-------------|
| `open_arduino_ide` | Open Arduino IDE (optionally with a sketch) |
| `arduino_cli_check` | Check arduino-cli installation |
| `arduino_cli_config` | Show/modify arduino-cli config |

## ESP32-S3 Dual USB

ESP32-S3 has two USB ports — `detect_board` handles this automatically:

| Port | Role | Chip |
|------|------|------|
| COM / UART | Upload sketches | CH343 (1a86:55d3) |
| USB | Serial monitor | Native ESP32-S3 (303a:1001) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCHES_DIR` | `~/Arduino` | Sketches directory |
| `ARDUINO_IDE_PATH` | `~/Applications/arduino-ide*.AppImage` | Arduino IDE path |

## Board Config (`~/.arduino-mcp.json`)

Automatically created by `detect_board`:

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
