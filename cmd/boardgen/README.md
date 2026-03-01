# boardgen

`boardgen` is a Go utility that generates SVG and JSON files for adding a new
board to the TinyGo Playground simulator [parts library](../../parts/).

The generated files follow the style conventions documented in
[parts/README.md](../../parts/README.md): hand-written SVG style, millimeter
units (1px == 1mm), absolute SVG path commands, and consistent pin/LED shapes
across boards.

## Installation

```bash
cd ./cmd/boardgen
go install .
```

### Examples

**Pico-like board** (horizontal, 20 pins top/bottom, USB on the left, built-in LED):

```bash
boardgen \
  -name my-pico \
  -human "My Pico Board" \
  -pins-top 20 -pins-bottom 20 \
  -usb left -led \
  -output ./parts
```

**Vertical board** (15 pins on each side, USB on top):

```bash
boardgen \
  -name my-nano \
  -pins-left 15 -pins-right 15 \
  -usb top -led \
  -orientation vertical \
  -output ./parts
```

**Four-sided board** (pins on all edges, custom PCB color):

```bash
boardgen \
  -name my-devkit \
  -pins-top 10 -pins-bottom 10 \
  -pins-left 8 -pins-right 8 \
  -usb left -led \
  -color "#10A2A1" \
  -output ./parts
```

**Minimal board** (only bottom pins, no USB, no LED):

```bash
go run ./cmd/boardgen \
  -name my-breakout \
  -pins-bottom 8 \
  -output ./parts
```

**Fixed-size board** (explicit dimensions, rectangular GND pads):

```bash
boardgen \
  -name my-wide-board \
  -pins-top 10 -pins-bottom 10 \
  -width 60 -height 30 \
  -rect-gnd \
  -usb left -led \
  -output ./parts
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `-name` | Board name — used for filenames (`<name>.svg`, `<name>.json`) | *required* |
| `-human` | Human-readable board name shown in the UI | title-cased `-name` |
| `-orientation` | Board orientation: `horizontal` or `vertical` | `horizontal` |
| `-pins-top` | Number of pins on the top edge | `0` |
| `-pins-bottom` | Number of pins on the bottom edge | `0` |
| `-pins-left` | Number of pins on the left edge | `0` |
| `-pins-right` | Number of pins on the right edge | `0` |
| `-usb` | Side for the USB port: `left`, `right`, `top`, or `bottom` | *(none)* |
| `-led` | Include a built-in LED (placed next to the USB port) | `false` |
| `-color` | PCB color as a hex string | `#006837` |
| `-width` | Board width in mm (0 = auto-sized from pins) | `0` |
| `-height` | Board height in mm (0 = auto-sized from pins) | `0` |
| `-rect-gnd` | Use rectangular pad shape for GND pins (taller, rounded corners) | `false` |
| `-format` | Firmware format string (e.g. `uf2`, `hex`) | `uf2` |
| `-output` | Output directory for generated files | `.` |

## What it generates

### SVG file (`<name>.svg`)

A board image that matches the project's visual conventions:

- **Millimeter units** — `viewBox` matches the physical board size so that
  1px == 1mm.
- **Castellated pads** — half-circle pad shapes matching the Raspberry Pi Pico
  style. When `-rect-gnd` is set, GND pads use a distinct taller rectangular
  shape with small rounded corners; otherwise all pads share the same
  half-circle shape.
- **Pin attributes** — each pad has `data-pin` (and `data-title` where the
  display name differs) for the simulator to connect wires.
- **USB port** — a `#ccc` rectangle protruding 1.3mm past the board edge on the
  specified side.
- **LED** — an animated `data-part="led"` element using CSS custom properties
  (`--color`, `--shadow`) for the simulator to control brightness.

### JSON file (`<name>.json`)

A complete board configuration for the simulator:

- **MCU part** with `GPIO0`–`GPIOn` pin mapping.
- **LED part** (when `-led` is set) with color and current values.
- **Wire table** connecting SVG `data-pin` names to MCU GPIOs, power (`vcc`),
  and ground (`gnd`).
- **`firmwareFormat`** and **`baseCurrent`** fields.

## Pin assignment

Pins are assigned automatically:

1. **GPIO pins** are numbered sequentially starting from `GP0`, distributed
   across sides in reading order: top → right → bottom → left.
2. **GND pins** are auto-inserted after every 5 GPIO pins on each side.
3. **Power pins** — when `-usb` is specified, the first three positions on the
   USB side are reserved for `VBUS`, `GND`, and `3V3`.
4. The **LED** (when enabled) is wired to the last GPIO pin.

## Board sizing

Board dimensions are computed automatically from the pin counts:

- Each pin occupies one **pitch** unit (2.54mm).
- Pad-depth zones (3.22mm) are added at edges that have pins.
- Corner gaps prevent overlapping when perpendicular sides both have pins.
- A minimum board dimension of 12mm is enforced.
- When USB is present, the `viewBox` extends to include the protruding port.

You can override the auto-computed size with `-width` and/or `-height` (in mm).
This is useful when you want a specific physical board size, or need extra space
between pin rows. The pin rows are still positioned based on the computed
pad-depth offsets, so the board will simply be larger in the overridden
dimension(s).
