# arduino-mcp

> MCP server for Arduino via arduino-cli — control any board from an AI assistant

Claude Code (or any MCP client) can write, compile, upload, monitor and diagram Arduino projects — hands-free.

[![npm version](https://img.shields.io/npm/v/arduino-mcp)](https://www.npmjs.com/package/arduino-mcp)
[![CI](https://github.com/biyusku/arduino-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/biyusku/arduino-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- 🔍 **Auto board detection** — finds upload and monitor ports automatically (handles ESP32-S3 dual-USB)
- 💾 **Board memory** — remembers FQBN, ports, flash, PSRAM after the first `detect_board`
- 📤 **One-command deploy** — `compile_and_upload` does everything in one shot
- 📡 **Persistent serial sessions** — `serial_start` keeps the port open and buffers output; uploads pause and resume it automatically
- 📬 **Serial send** — send commands to the board (no unwanted reset on Uno/Nano)
- 🌐 **OTA / WiFi upload** — upload over the air without USB
- 📦 **Project system** — `arduino-mcp.yaml` per sketch: board, ports, libraries and build flags used by compile/upload
- 🔌 **Circuit diagrams** — SVG + Markdown wiring diagrams from pin connections
- 📚 **Library & platform management** — install, uninstall, list, search, update
- 🛡️ **Safe by design** — no shell, no `sudo`/`chmod`, validated names and paths, destructive tools are annotated
- 🖥️ **Cross-platform** — Linux, macOS, Windows

## Supported Boards

| Platform | Examples |
|----------|----------|
| ESP32 | ESP32, ESP32-S3, ESP32-S2, ESP32-C3 |
| Arduino AVR | Uno, Mega, Nano, Leonardo, Micro |
| RP2040 | Raspberry Pi Pico, Arduino Nano RP2040 |
| SAMD | Arduino Zero, MKR series |
| ESP8266 | NodeMCU, Wemos D1 |
| Any arduino-cli compatible board | STM32, Renesas (Uno R4), ... |

## Requirements

- [arduino-cli](https://arduino.github.io/arduino-cli/latest/installation/) on `$PATH` (or set `ARDUINO_CLI_PATH`)
- Node.js 20+
- Linux, macOS or Windows
- Linux only: permission to use serial ports — add yourself to the `dialout` group once (`uucp` on Arch) and log in again:
  ```bash
  sudo usermod -aG dialout $USER
  ```
- Optional: [esptool](https://github.com/espressif/esptool) for `erase_flash` / `board_info` on ESP boards (the copy bundled with the ESP32 core is found automatically)

## Installation

### npx (no install needed)
```bash
claude mcp add arduino-mcp --scope user -- npx arduino-mcp
```

### From source
```bash
git clone https://github.com/biyusku/arduino-mcp
cd arduino-mcp
npm install && npm run build
claude mcp add arduino-mcp --scope user -- node /absolute/path/to/arduino-mcp/dist/index.js
```

Restart Claude Code after adding.

## Quick Start

Ask in any language, for example:

```
"detect my board"                       → detect_board
"create a blink sketch"                 → create_sketch (template: blink)
"compile and upload blink"              → compile_and_upload
"read serial output in the background"  → serial_start + serial_read
"send LED_ON to the board"              → send_serial
"draw the DHT11 wiring"                 → quick_diagram
"create a project file for blink"       → project_init
```

## Tools (42 total)

### Board (6)
| Tool | Description |
|------|-------------|
| `detect_board` | Auto-detect board, save ports & FQBN (keeps your saved options) |
| `board_config` | Show or update saved board settings (incl. manual setup when detection fails) |
| `board_options` | List all FQBN menu options of a board (flash, psram, cpu…) |
| `list_boards` | List connected boards with upload/monitor roles |
| `board_info` | USB details; chip, MAC, flash size for ESP boards (esptool) |
| `erase_flash` | Erase all flash memory (ESP32/ESP8266 only) ⚠️ |

### Sketch (6)
| Tool | Description |
|------|-------------|
| `list_sketches` | List sketches with modification dates |
| `create_sketch` | Create sketch (templates: blink/wifi/mqtt/sensor/servo/i2c_scan/empty/custom); never overwrites unless asked |
| `read_sketch` | Read sketch source code |
| `write_sketch` | Write/update sketch source code |
| `delete_sketch` | Delete a sketch folder ⚠️ |
| `rename_sketch` | Rename a sketch |

### Compile & Upload (4)
| Tool | Description |
|------|-------------|
| `compile_sketch` | Compile, errors as file:line:col (incl. missing headers and linker errors) |
| `upload_sketch` | Upload the last build |
| `compile_and_upload` | Compile + upload in one step ⭐ |
| `wifi_upload` | OTA upload over WiFi (ArduinoOTA) |

Before uploading, serial sessions of this server on the board's ports are paused and resumed afterwards. With `free_port` (default on), other programs that keep the port open are stopped; the result lists which ones.

### Serial (7)
| Tool | Description |
|------|-------------|
| `serial_monitor` | Read serial output for N seconds |
| `serial_start` | Start a persistent background serial session |
| `serial_read` | Read lines from the background buffer |
| `serial_stop` | Stop background serial session(s) |
| `serial_status` | Show active serial sessions |
| `send_serial` | Send data/command to the board and read the reply |
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
| `project_init` | Create `arduino-mcp.yaml` project config |
| `project_info` | Show project config and files |
| `project_list_files` | List source files (.ino, .h, .cpp, … incl. `src/`) |
| `project_read_file` | Read a project file |
| `project_write_file` | Write a header/source file to the project |
| `project_install_deps` | Install all libraries from the project config |

### Diagram (2)
| Tool | Description |
|------|-------------|
| `quick_diagram` | Wiring diagram from text connections |
| `generate_diagram` | Full diagram with components, SVG and/or Markdown |

### IDE & CLI (3)
| Tool | Description |
|------|-------------|
| `open_arduino_ide` | Open Arduino IDE 2 (optionally with a sketch) |
| `arduino_cli_check` | Check arduino-cli installation |
| `arduino_cli_config` | Show config, add board manager URL, reset (needs `confirm`) |

⚠️ = annotated as destructive, so MCP clients can ask for confirmation.

## ESP32-S3 Dual USB

ESP32-S3 boards with two USB ports are handled automatically by `detect_board`:

| Port | Role | Chip |
|------|------|------|
| COM / UART | Upload sketches | CH343 (1a86:55d3) |
| USB | Serial monitor | Native ESP32-S3 (303a:1001) |

Only this CH343 + native-USB combination is paired automatically. With other dual-USB layouts (e.g. CP2102 + native USB),
`detect_board` uses the native port for both and lists the other one. If more than one board is connected, `detect_board`
lists the other ports; pick the right ones with `board_config`.

## Project Config (`arduino-mcp.yaml`)

```yaml
# arduino-mcp project config
name: my_project
description: My Arduino project
version: 1.0.0
fqbn: esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi
upload_port: /dev/ttyACM1
monitor_port: /dev/ttyACM0
baud: 115200
libraries:
  - ArduinoJson
  - FastLED
  - DHT sensor library
build_flags:
  - -DDEBUG=1
```

Compile and upload tools resolve settings in this order: **tool argument → `arduino-mcp.yaml` → saved board**.
`project_init` only pins `fqbn` and ports you pass explicitly, so `detect_board`/`board_config` changes keep applying to the sketch.
A pinned port that is not connected falls back to the saved board's port, as long as the sketch is built for that saved board
(otherwise the upload stops instead of flashing a different board). Files written by arduino-mcp v3 are still read, but
their `fqbn`/port entries (copies of the board saved back then, never used by v3) are ignored.
`build_flags` are passed to the compiler as `compiler.cpp.extra_flags` / `compiler.c.extra_flags`. Because a sketch folder may come from
anywhere, only harmless flags are accepted, one per entry: `-DNAME[=value]`, `-UNAME`, `-O<level>`, `-g`, `-std=...`, `-W<warning>`,
`-f<option>[=<number>]`, `-m<option>`.

## Board Config (`~/.arduino-mcp.json`)

Created by `detect_board` (or `board_config` with `action=set`):

```json
{
  "defaultBoard": "E8F60A89EE74",
  "boards": {
    "E8F60A89EE74": {
      "fqbn": "esp32:esp32:esp32s3",
      "family": "esp32",
      "uploadPort": "/dev/ttyACM1",
      "monitorPort": "/dev/ttyACM0",
      "cdcOnBoot": "cdc",
      "flashSize": "16M",
      "psram": "opi",
      "lastSeen": "2026-10-06T00:00:00.000Z"
    }
  }
}
```

Board options are only added when you set them, so the board's defaults apply otherwise. Options that are not specific to ESP boards (e.g. `cpu=atmega328old` for an old-bootloader Nano) go into `extra_options`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCHES_DIR` | `~/Arduino` | Sketches directory |
| `ARDUINO_MCP_CONFIG` | `~/.arduino-mcp.json` | Saved board settings |
| `ARDUINO_IDE_PATH` | auto-detected | Arduino IDE executable, AppImage or `.app` |
| `ESPTOOL_PATH` | auto-detected | esptool executable |

## Security

The server runs tools on request of an AI model, whose input can be influenced by web pages, library descriptions or serial output. So:

- External programs are started **without a shell**, with argument arrays; values can never become shell commands.
- Sketch names must match `[A-Za-z0-9][A-Za-z0-9_.-]*`; file paths must stay inside the sketch folder.
- Ports must be serial devices (`/dev/...`, `COMx`); FQBNs, URLs and hosts are validated.
- Compiler flags from `arduino-mcp.yaml` are limited to an allowlist (no `-wrapper`, `-fplugin=`, `-Wl,`, `@file`, ...).
- Freeing a busy port only ever affects real serial devices, never terminals or this server's own client.
- No `chmod`/`sudo` on devices: missing permissions are reported with the fix.
- Destructive tools (`delete_sketch`, `erase_flash`, `uninstall_library`, `arduino_cli_config`) carry the MCP `destructiveHint`; `arduino_cli_config reset` also needs `confirm: true`.
- Note: the OTA password of `wifi_upload` is passed to arduino-cli on its command line.

## Development

```bash
npm install
npm run typecheck   # strict TypeScript, src + tests
npm test            # unit + end-to-end tests (MCP over stdio, fake arduino-cli, fake serial board on Linux)
npm run build
```

## License

MIT — [birusk](https://github.com/biyusku)
