# arduino-mcp

> Universal MCP server for Arduino IDE & arduino-cli — control any board via AI

Claude Code (or any MCP client) can write, compile, upload, monitor, and diagram Arduino projects — fully hands-free.

[![npm version](https://img.shields.io/npm/v/arduino-mcp)](https://www.npmjs.com/package/arduino-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- 🔍 **Auto board detection** — finds upload and monitor ports automatically (handles ESP32-S3 dual-USB)
- 💾 **Board memory** — remembers FQBN, ports, flash, PSRAM after first `detect_board`
- 📤 **One-command deploy** — `compile_and_upload` does everything in one shot
- 🔓 **Auto port unlock** — frees busy serial ports before uploading
- 📡 **Persistent serial buffer** — `serial_start` buffers all output in background, read anytime
- 📬 **Serial send** — send commands to board over serial
- 🌐 **OTA / WiFi upload** — upload over the air without USB
- 📦 **Project system** — `arduino-mcp.yaml` with multi-file support, dependencies, build config
- 🔌 **Circuit diagrams** — generate SVG + Markdown wiring diagrams from pin connections
- 📚 **Full library management** — install, uninstall, list, search, update
- ⚙️ **All FQBN options** — flash size, PSRAM, CDC on boot, partition scheme, upload speed
- 🖥️ **IDE launcher** — open Arduino IDE with a specific sketch
- 🛠️ **42 tools total** across board, sketch, compile, serial, library, project, and diagram categories

## Supported Boards

| Platform | Examples |
|----------|---------|
| ESP32 | ESP32, ESP32-S3, ESP32-S2, ESP32-C3 |
| Arduino AVR | Uno, Mega, Nano, Leonardo, Micro |
| RP2040 | Raspberry Pi Pico, Arduino Nano RP2040 |
| SAMD | Arduino Zero, MKR series |
| ESP8266 | NodeMCU, Wemos D1 |
| Any arduino-cli compatible board | ... |

## Requirements

- [arduino-cli](https://arduino.github.io/arduino-cli/) on `$PATH`
- Node.js 18+
- Linux / macOS

## Installation

### npx (no install needed)
```bash
claude mcp add arduino-mcp --scope user -- npx arduino-mcp
```

### From source
```bash
git clone https://github.com/birusk/arduino-mcp
cd arduino-mcp
npm install && npm run build
claude mcp add arduino-mcp --scope user -- node /absolute/path/to/arduino-mcp/dist/index.js
```

Restart Claude Code after adding.

## Quick Start

```
"kartımı tanı ve kaydet"          → detect_board
"blink sketch oluştur"            → create_sketch (template: blink)
"blink'i derle ve yükle"          → compile_and_upload
"serial çıktıyı arka planda oku"  → serial_start + serial_read
"karta 'LED_ON' gönder"           → send_serial
"DHT11 bağlantı şeması çıkar"     → quick_diagram
"proje dosyası oluştur"           → project_init
```

## Tools (42 total)

### Board (6)
| Tool | Description |
|------|-------------|
| `detect_board` | Auto-detect board, save ports & FQBN |
| `board_config` | Show or update saved board settings |
| `board_options` | List all FQBN options (flash, psram, cdc…) |
| `list_boards` | List connected boards with upload/monitor roles |
| `board_info` | Detailed board info (chip, MAC, revision) |
| `erase_flash` | Erase all flash memory (ESP32 only) |

### Sketch (6)
| Tool | Description |
|------|-------------|
| `list_sketches` | List sketches with modification dates |
| `create_sketch` | Create sketch (templates: blink/wifi/mqtt/sensor/servo/i2c_scan/empty) |
| `read_sketch` | Read sketch source code |
| `write_sketch` | Write/update sketch source code |
| `delete_sketch` | Delete a sketch folder |
| `rename_sketch` | Rename a sketch |

### Compile & Upload (4)
| Tool | Description |
|------|-------------|
| `compile_sketch` | Compile with error line:col formatting |
| `upload_sketch` | Upload (auto-unlocks busy port) |
| `compile_and_upload` | Compile + upload in one step ⭐ |
| `wifi_upload` | OTA upload over WiFi |

### Serial (7)
| Tool | Description |
|------|-------------|
| `serial_monitor` | One-shot serial read (N seconds) |
| `serial_start` | Start persistent background serial buffer |
| `serial_read` | Read lines from background buffer |
| `serial_stop` | Stop background serial buffer |
| `serial_status` | Show active serial sessions |
| `send_serial` | Send data/command to board |
| `get_serial_ports` | List all ports with roles (upload/monitor) |

### Libraries & Platforms (8)
| Tool | Description |
|------|-------------|
| `install_library` | Install library (with optional version) |
| `uninstall_library` | Uninstall a library |
| `list_libraries` | List installed libraries |
| `search_library` | Search Arduino library index |
| `update_libraries` | Update all installed libraries |
| `install_board` | Install board platform (ESP32/AVR/RP2040…) |
| `update_boards` | Update all board platforms |
| `list_installed_boards` | List installed platforms |

### Project (6)
| Tool | Description |
|------|-------------|
| `project_init` | Create arduino-mcp.yaml project config |
| `project_info` | Show project config and files |
| `project_list_files` | List source files (.ino, .h, .cpp) |
| `project_read_file` | Read a specific project file |
| `project_write_file` | Write a header/source file to project |
| `project_install_deps` | Install all libraries from project config |

### Diagram (2)
| Tool | Description |
|------|-------------|
| `quick_diagram` | Generate wiring diagram from text connections |
| `generate_diagram` | Full diagram with components & SVG output |

### IDE & CLI (3)
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

## Project Config (`arduino-mcp.yaml`)

```yaml
# arduino-mcp project config
name: my_project
description: My Arduino project
version: 1.0.0
fqbn: esp32:esp32:esp32s3:CDCOnBoot=default,FlashSize=16M,PSRAM=opi
upload_port: /dev/ttyACM1
monitor_port: /dev/ttyACM0
baud: 115200
libraries:
  - ArduinoJson
  - FastLED
  - DHT sensor library
```

## Board Config (`~/.arduino-mcp.json`)

Automatically created by `detect_board`:

```json
{
  "defaultBoard": "E8F60A89EE74",
  "boards": {
    "E8F60A89EE74": {
      "fqbn": "esp32:esp32:esp32s3",
      "family": "esp32",
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCHES_DIR` | `~/Arduino` | Sketches directory |
| `ARDUINO_IDE_PATH` | `~/Applications/arduino-ide*.AppImage` | Arduino IDE path |

## License

MIT — [birusk](https://github.com/birusk)
