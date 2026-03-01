package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// All measurements in millimeters, matching existing board files.
const (
	pitch    = 2.54 // standard pin pitch
	padDepth = 3.22 // depth of castellated pad clickable area
	padInset = 0.47 // visual pad inset inside the pad area

	usbLongDim  = 8.0 // USB port long dimension
	usbShortDim = 6.0 // USB port short dimension
	usbProtrude = 1.3 // USB protrusion past board edge

	ledW = 2.0 // LED rectangle width
	ledH = 1.2 // LED rectangle height

	gndEvery    = 5    // insert a GND pin after every N GPIO pins
	cornerGap   = 1.0  // gap between perpendicular pin rows at corners
	minBoardDim = 12.0 // minimum board width or height
)

// SVG pad path templates derived from parts/pico.svg.
// Regular pads: half-circle (castellated) end facing into the board.
// GND pads: taller rectangle with small rounded corners.

// Top pads (flat top edge at y=0, shape grows downward).
var topPaths = [2]string{
	`M 0,0 H 1.6 V 1.61 A 0.8 0.8 0 0 1 0 1.61 Z`,
	`M 0,0 H 1.6 V 2.21 a 0.2 0.2 0 0 1 -0.2 0.2 h -1.2 a 0.2 0.2 0 0 1 -0.2 -0.2 Z`,
}

// Bottom pads (flat bottom edge, shape grows upward).
var bottomPaths = [2]string{
	`M 0,0 H 1.6 V -1.61 A 0.8 0.8 0 0 0 0 -1.61 Z`,
	`M 0,0 H 1.6 V -2.21 a 0.2 0.2 0 0 0 -0.2 -0.2 H 0.2 a 0.2 0.2 0 0 0 -0.2 0.2 Z`,
}

// Left pads (flat left edge at x=0, shape grows rightward).
var leftPaths = [2]string{
	`M 0,0 V 1.6 H 1.61 A 0.8 0.8 0 0 0 1.61 0 Z`,
	`M 0,0 V 1.6 H 2.21 a 0.2 0.2 0 0 0 0.2 -0.2 V 0.2 a 0.2 0.2 0 0 0 -0.2 -0.2 Z`,
}

// Right pads (flat right edge, shape grows leftward).
var rightPaths = [2]string{
	`M 0,0 V 1.6 H -1.61 A 0.8 0.8 0 0 1 -1.61 0 Z`,
	`M 0,0 V 1.6 H -2.21 a 0.2 0.2 0 0 1 -0.2 -0.2 V 0.2 a 0.2 0.2 0 0 1 0.2 -0.2 Z`,
}

// BoardConfig holds all user-specified parameters.
type BoardConfig struct {
	Name           string
	HumanName      string
	Orientation    string
	PinsTop        int
	PinsBottom     int
	PinsLeft       int
	PinsRight      int
	HasUSB         bool
	USBSide        string
	HasLED         bool
	OutputDir      string
	PCBColor       string
	FirmwareFormat string
	Width          float64 // explicit board width in mm (0 = auto)
	Height         float64 // explicit board height in mm (0 = auto)
	RectGnd        bool    // use rectangular pad shape for GND
}

// Pin represents a single pin on the board.
type Pin struct {
	Name    string
	Title   string
	Type    string // "gpio", "gnd", "vcc", "3v3"
	GPIONum int
	Side    string // "top", "bottom", "left", "right"
	Index   int
}

// Layout holds computed board dimensions and pin assignments.
type Layout struct {
	BoardW, BoardH          float64
	ViewX, ViewY            float64
	ViewW, ViewH            float64
	TopStartX, BottomStartX float64
	LeftStartY, RightStartY float64
	HasUSBRect              bool
	USBX, USBY              float64
	USBW, USBH              float64
	HasLED                  bool
	LEDX, LEDY              float64
	RectGnd                 bool
	Pins                    []Pin
	NumGPIO                 int
	LEDPin                  int
}

// JSON output types.

type BoardJSON struct {
	Name           string     `json:"name"`
	HumanName      string     `json:"humanName"`
	FirmwareFormat string     `json:"firmwareFormat"`
	SVG            string     `json:"svg"`
	MainPart       string     `json:"mainPart"`
	BaseCurrent    float64    `json:"baseCurrent"`
	Parts          []PartJSON `json:"parts"`
	Wires          []WireJSON `json:"wires"`
}

type PartJSON struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	HumanName string          `json:"humanName,omitempty"`
	Pins      json.RawMessage `json:"pins,omitempty"`
	Color     []int           `json:"color,omitempty"`
	Current   float64         `json:"current,omitempty"`
}

type WireJSON struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func main() {
	cfg := parseFlags()
	if err := validate(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		flag.Usage()
		os.Exit(1)
	}

	layout := computeLayout(cfg)
	svgContent := generateSVG(cfg, layout)
	jsonContent := generateJSON(cfg, layout)

	if err := os.MkdirAll(cfg.OutputDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "Error creating output directory: %v\n", err)
		os.Exit(1)
	}

	svgPath := filepath.Join(cfg.OutputDir, cfg.Name+".svg")
	jsonPath := filepath.Join(cfg.OutputDir, cfg.Name+".json")

	if err := os.WriteFile(svgPath, []byte(svgContent), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing SVG: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(jsonPath, []byte(jsonContent), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing JSON: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Generated:\n  %s\n  %s\n", svgPath, jsonPath)
	fmt.Printf("Board: %s (%s)\n", cfg.HumanName, cfg.Name)
	fmt.Printf("Size:  %.1f x %.1f mm\n", layout.BoardW, layout.BoardH)
	fmt.Printf("GPIO pins: %d\n", layout.NumGPIO)
	if layout.HasLED {
		fmt.Printf("LED on GPIO%d\n", layout.LEDPin)
	}
}

func parseFlags() BoardConfig {
	var cfg BoardConfig
	flag.StringVar(&cfg.Name, "name", "", "Board name (required; used for filenames)")
	flag.StringVar(&cfg.HumanName, "human", "", "Human-readable board name (default: title-cased -name)")
	flag.StringVar(&cfg.Orientation, "orientation", "horizontal", "Board orientation: horizontal or vertical")
	flag.IntVar(&cfg.PinsTop, "pins-top", 0, "Number of pins on the top edge")
	flag.IntVar(&cfg.PinsBottom, "pins-bottom", 0, "Number of pins on the bottom edge")
	flag.IntVar(&cfg.PinsLeft, "pins-left", 0, "Number of pins on the left edge")
	flag.IntVar(&cfg.PinsRight, "pins-right", 0, "Number of pins on the right edge")
	flag.StringVar(&cfg.USBSide, "usb", "", "Side for USB port: left, right, top, bottom (omit for no USB)")
	flag.BoolVar(&cfg.HasLED, "led", false, "Include a built-in LED (placed next to USB port)")
	flag.StringVar(&cfg.OutputDir, "output", ".", "Output directory for generated files")
	flag.StringVar(&cfg.PCBColor, "color", "#006837", "PCB color as hex (default: TinyGo green)")
	flag.StringVar(&cfg.FirmwareFormat, "format", "uf2", "Firmware format string (e.g. uf2, hex)")
	flag.Float64Var(&cfg.Width, "width", 0, "Board width in mm (0 = auto-sized from pins)")
	flag.Float64Var(&cfg.Height, "height", 0, "Board height in mm (0 = auto-sized from pins)")
	flag.BoolVar(&cfg.RectGnd, "rect-gnd", false, "Use rectangular pad shape for GND pins")
	flag.Parse()

	cfg.HasUSB = cfg.USBSide != ""
	if cfg.HumanName == "" && cfg.Name != "" {
		cfg.HumanName = titleCase(strings.ReplaceAll(cfg.Name, "-", " "))
	}
	return cfg
}

func validate(cfg BoardConfig) error {
	if cfg.Name == "" {
		return fmt.Errorf("-name is required")
	}
	if cfg.PinsTop+cfg.PinsBottom+cfg.PinsLeft+cfg.PinsRight == 0 {
		return fmt.Errorf("at least one side must have pins")
	}
	if cfg.HasUSB {
		switch cfg.USBSide {
		case "left", "right", "top", "bottom":
		default:
			return fmt.Errorf("invalid -usb value %q; must be left, right, top, or bottom", cfg.USBSide)
		}
	}
	switch cfg.Orientation {
	case "horizontal", "vertical":
	default:
		return fmt.Errorf("invalid -orientation %q; must be horizontal or vertical", cfg.Orientation)
	}
	for _, v := range []struct {
		n string
		v int
	}{
		{"pins-top", cfg.PinsTop}, {"pins-bottom", cfg.PinsBottom},
		{"pins-left", cfg.PinsLeft}, {"pins-right", cfg.PinsRight},
	} {
		if v.v < 0 {
			return fmt.Errorf("-%s must be >= 0", v.n)
		}
	}
	if cfg.Width < 0 {
		return fmt.Errorf("-width must be >= 0")
	}
	if cfg.Height < 0 {
		return fmt.Errorf("-height must be >= 0")
	}
	return nil
}

// assignPins distributes GPIO, GND, and power pins across the four sides.
func assignPins(cfg BoardConfig) ([]Pin, int) {
	var pins []Pin
	gpioNum := 0
	gndNum := 0

	processSide := func(side string, count int) {
		if count == 0 {
			return
		}
		isUSB := cfg.HasUSB && side == cfg.USBSide
		gpioOnSide := 0
		startIdx := 0

		if isUSB && count >= 3 {
			pins = append(pins, Pin{Name: "VBUS", Type: "vcc", GPIONum: -1, Side: side, Index: 0})
			gndNum++
			pins = append(pins, Pin{
				Name: fmt.Sprintf("GND#%d", gndNum), Title: "GND",
				Type: "gnd", GPIONum: -1, Side: side, Index: 1,
			})
			pins = append(pins, Pin{Name: "3V3", Title: "3.3V", Type: "3v3", GPIONum: -1, Side: side, Index: 2})
			startIdx = 3
		}

		lastWasGND := false
		for i := startIdx; i < count; i++ {
			if gpioOnSide > 0 && gpioOnSide%gndEvery == 0 && !lastWasGND {
				gndNum++
				pins = append(pins, Pin{
					Name: fmt.Sprintf("GND#%d", gndNum), Title: "GND",
					Type: "gnd", GPIONum: -1, Side: side, Index: i,
				})
				lastWasGND = true
			} else {
				pins = append(pins, Pin{
					Name: fmt.Sprintf("GP%d", gpioNum), Type: "gpio",
					GPIONum: gpioNum, Side: side, Index: i,
				})
				gpioNum++
				gpioOnSide++
				lastWasGND = false
			}
		}
	}

	processSide("top", cfg.PinsTop)
	processSide("right", cfg.PinsRight)
	processSide("bottom", cfg.PinsBottom)
	processSide("left", cfg.PinsLeft)

	return pins, gpioNum
}

func computeLayout(cfg BoardConfig) Layout {
	pins, numGPIO := assignPins(cfg)

	hasTop := cfg.PinsTop > 0
	hasBottom := cfg.PinsBottom > 0
	hasLeft := cfg.PinsLeft > 0
	hasRight := cfg.PinsRight > 0

	topPad := condF(hasTop, padDepth, 0)
	bottomPad := condF(hasBottom, padDepth, 0)
	leftPad := condF(hasLeft, padDepth, 0)
	rightPad := condF(hasRight, padDepth, 0)

	cgl := condF(hasLeft && (hasTop || hasBottom), cornerGap, 0)
	cgr := condF(hasRight && (hasTop || hasBottom), cornerGap, 0)
	cgt := condF(hasTop && (hasLeft || hasRight), cornerGap, 0)
	cgb := condF(hasBottom && (hasLeft || hasRight), cornerGap, 0)

	hPins := maxI(cfg.PinsTop, cfg.PinsBottom)
	vPins := maxI(cfg.PinsLeft, cfg.PinsRight)
	hSpan := float64(hPins) * pitch
	vSpan := float64(vPins) * pitch

	contentW := math.Max(hSpan+cgl+cgr, minBoardDim)
	contentH := math.Max(vSpan+cgt+cgb, minBoardDim)
	if hasTop && hasBottom {
		contentH = math.Max(contentH, 14.0)
	}
	if hasLeft && hasRight {
		contentW = math.Max(contentW, 14.0)
	}

	boardW := leftPad + contentW + rightPad
	boardH := topPad + contentH + bottomPad

	// Apply explicit size overrides if provided.
	if cfg.Width > 0 {
		boardW = cfg.Width
	}
	if cfg.Height > 0 {
		boardH = cfg.Height
	}

	lay := Layout{
		BoardW:       boardW,
		BoardH:       boardH,
		ViewX:        0,
		ViewY:        0,
		ViewW:        boardW,
		ViewH:        boardH,
		TopStartX:    leftPad + cgl,
		BottomStartX: leftPad + cgl,
		LeftStartY:   topPad + cgt,
		RightStartY:  topPad + cgt,
		RectGnd:      cfg.RectGnd,
		Pins:         pins,
		NumGPIO:      numGPIO,
		LEDPin:       -1,
	}

	if cfg.HasUSB {
		lay.HasUSBRect = true
		switch cfg.USBSide {
		case "left":
			lay.USBW = usbShortDim
			lay.USBH = usbLongDim
			lay.USBX = -usbProtrude
			lay.USBY = (boardH - usbLongDim) / 2
			lay.ViewX = -usbProtrude
			lay.ViewW = boardW + usbProtrude
		case "right":
			lay.USBW = usbShortDim
			lay.USBH = usbLongDim
			lay.USBX = boardW - usbShortDim + usbProtrude
			lay.USBY = (boardH - usbLongDim) / 2
			lay.ViewW = boardW + usbProtrude
		case "top":
			lay.USBW = usbLongDim
			lay.USBH = usbShortDim
			lay.USBX = (boardW - usbLongDim) / 2
			lay.USBY = -usbProtrude
			lay.ViewY = -usbProtrude
			lay.ViewH = boardH + usbProtrude
		case "bottom":
			lay.USBW = usbLongDim
			lay.USBH = usbShortDim
			lay.USBX = (boardW - usbLongDim) / 2
			lay.USBY = boardH - usbShortDim + usbProtrude
			lay.ViewH = boardH + usbProtrude
		}
	}

	if cfg.HasLED && numGPIO > 0 {
		lay.HasLED = true
		lay.LEDPin = numGPIO - 1
		switch cfg.USBSide {
		case "left":
			lay.LEDX = usbShortDim - usbProtrude + 1.0
			lay.LEDY = (boardH+usbLongDim)/2 + 1.0
		case "right":
			lay.LEDX = boardW - usbShortDim + usbProtrude - ledW - 1.0
			lay.LEDY = (boardH+usbLongDim)/2 + 1.0
		case "top":
			lay.LEDX = (boardW+usbLongDim)/2 + 1.0
			lay.LEDY = usbShortDim - usbProtrude + 1.0
		case "bottom":
			lay.LEDX = (boardW+usbLongDim)/2 + 1.0
			lay.LEDY = boardH - usbShortDim + usbProtrude - ledH - 1.0
		default:
			lay.LEDX = boardW/2 - ledW/2
			lay.LEDY = boardH/2 - ledH/2
		}
		lay.LEDX = math.Max(1, math.Min(lay.LEDX, boardW-ledW-1))
		lay.LEDY = math.Max(1, math.Min(lay.LEDY, boardH-ledH-1))
	}

	return lay
}

func generateSVG(cfg BoardConfig, lay Layout) string {
	var b strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }

	w("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n")
	w("<!-- Generated by boardgen for the TinyGo Playground simulator. -->\n")
	w("<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"%s %s %s %s\" width=\"%smm\" height=\"%smm\">\n",
		ff(lay.ViewX), ff(lay.ViewY), ff(lay.ViewW), ff(lay.ViewH),
		ff(lay.ViewW), ff(lay.ViewH))

	w("\n  <!-- PCB -->\n")
	w("  <rect x=\"0\" y=\"0\" width=\"%s\" height=\"%s\" fill=\"%s\"/>\n",
		ff(lay.BoardW), ff(lay.BoardH), cfg.PCBColor)

	if lay.HasUSBRect {
		w("\n  <!-- USB port -->\n")
		w("  <rect x=\"%s\" y=\"%s\" width=\"%s\" height=\"%s\" fill=\"#ccc\"/>\n",
			ff(lay.USBX), ff(lay.USBY), ff(lay.USBW), ff(lay.USBH))
	}

	if lay.HasLED {
		w("\n  <!-- LED -->\n")
		w("  <g data-part=\"led\" transform=\"translate(%s, %s)\">\n", ff(lay.LEDX), ff(lay.LEDY))
		w("    <rect width=\"%s\" height=\"%s\" fill=\"black\"/>\n", ff(ledW), ff(ledH))
		w("    <rect width=\"%s\" height=\"%s\" style=\"fill: var(--color, black); filter: drop-shadow(0 0 1px var(--shadow)) drop-shadow(0 0 1px var(--shadow));\"/>\n",
			ff(ledW), ff(ledH))
		w("  </g>\n")
	}

	writePinRow(&b, "top", lay)
	writePinRow(&b, "bottom", lay)
	writePinRow(&b, "left", lay)
	writePinRow(&b, "right", lay)

	w("</svg>\n")
	return b.String()
}

func writePinRow(b *strings.Builder, side string, lay Layout) {
	var sidePins []Pin
	for _, p := range lay.Pins {
		if p.Side == side {
			sidePins = append(sidePins, p)
		}
	}
	if len(sidePins) == 0 {
		return
	}

	w := func(f string, a ...any) { fmt.Fprintf(b, f, a...) }

	var gx, gy float64
	switch side {
	case "top":
		gx, gy = lay.TopStartX, 0
	case "bottom":
		gx, gy = lay.BottomStartX, lay.BoardH-padDepth
	case "left":
		gx, gy = 0, lay.LeftStartY
	case "right":
		gx, gy = lay.BoardW-padDepth, lay.RightStartY
	}

	w("\n  <!-- pads on the %s -->\n", side)
	w("  <g transform=\"translate(%s, %s)\" fill=\"transparent\">\n", ff(gx), ff(gy))

	for _, pin := range sidePins {
		attr := fmt.Sprintf("data-pin=\"%s\"", pin.Name)
		if pin.Title != "" {
			attr += fmt.Sprintf(" data-title=\"%s\"", pin.Title)
		}
		gndIdx := 0
		if pin.Type == "gnd" && lay.RectGnd {
			gndIdx = 1
		}

		switch side {
		case "top":
			x := float64(pin.Index) * pitch
			w("    <g %s transform=\"translate(%s, 0)\">\n", attr, ff(x))
			w("      <path transform=\"translate(%s, 0)\" d=\"%s\" fill=\"#d4af37\"/>\n",
				ff(padInset), topPaths[gndIdx])
			w("      <rect width=\"%s\" height=\"%s\" class=\"area\"/>\n", ff(pitch), ff(padDepth))
			w("    </g>\n")

		case "bottom":
			x := float64(pin.Index) * pitch
			w("    <g %s transform=\"translate(%s, 0)\">\n", attr, ff(x))
			w("      <path transform=\"translate(%s, %s)\" d=\"%s\" fill=\"#d4af37\"/>\n",
				ff(padInset), ff(padDepth), bottomPaths[gndIdx])
			w("      <rect width=\"%s\" height=\"%s\" class=\"area\"/>\n", ff(pitch), ff(padDepth))
			w("    </g>\n")

		case "left":
			y := float64(pin.Index) * pitch
			w("    <g %s transform=\"translate(0, %s)\">\n", attr, ff(y))
			w("      <path transform=\"translate(0, %s)\" d=\"%s\" fill=\"#d4af37\"/>\n",
				ff(padInset), leftPaths[gndIdx])
			w("      <rect width=\"%s\" height=\"%s\" class=\"area\"/>\n", ff(padDepth), ff(pitch))
			w("    </g>\n")

		case "right":
			y := float64(pin.Index) * pitch
			w("    <g %s transform=\"translate(0, %s)\">\n", attr, ff(y))
			w("      <path transform=\"translate(%s, %s)\" d=\"%s\" fill=\"#d4af37\"/>\n",
				ff(padDepth), ff(padInset), rightPaths[gndIdx])
			w("      <rect width=\"%s\" height=\"%s\" class=\"area\"/>\n", ff(padDepth), ff(pitch))
			w("    </g>\n")
		}
	}

	w("  </g>\n")
}

func generateJSON(cfg BoardConfig, lay Layout) string {
	var pinsJSON strings.Builder
	pinsJSON.WriteString("{\n")
	for i := 0; i < lay.NumGPIO; i++ {
		if i > 0 {
			pinsJSON.WriteString(",\n")
		}
		fmt.Fprintf(&pinsJSON, "                \"GPIO%d\": %d", i, i)
	}
	pinsJSON.WriteString("\n            }")

	board := BoardJSON{
		Name:           cfg.Name,
		HumanName:      cfg.HumanName,
		FirmwareFormat: cfg.FirmwareFormat,
		SVG:            cfg.Name + ".svg",
		MainPart:       "mcu",
		BaseCurrent:    0.020,
		Parts: []PartJSON{
			{
				ID:   "mcu",
				Type: "mcu",
				Pins: json.RawMessage(pinsJSON.String()),
			},
		},
	}

	if lay.HasLED {
		board.Parts = append(board.Parts, PartJSON{
			ID:        "led",
			Type:      "led",
			HumanName: "LED",
			Color:     []int{196, 255, 0},
			Current:   0.0024,
		})
	}

	for _, pin := range lay.Pins {
		switch pin.Type {
		case "gpio":
			board.Wires = append(board.Wires, WireJSON{
				From: fmt.Sprintf("mcu.GPIO%d", pin.GPIONum),
				To:   pin.Name,
			})
		case "gnd":
			board.Wires = append(board.Wires, WireJSON{From: "gnd", To: pin.Name})
		case "vcc":
			board.Wires = append(board.Wires, WireJSON{From: "vcc", To: pin.Name})
		case "3v3":
			board.Wires = append(board.Wires, WireJSON{From: "vcc", To: pin.Name})
		}
	}

	if lay.HasLED && lay.LEDPin >= 0 {
		board.Wires = append(board.Wires, WireJSON{
			From: fmt.Sprintf("mcu.GPIO%d", lay.LEDPin),
			To:   "led.anode",
		})
	}

	data, err := json.MarshalIndent(board, "", "    ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling JSON: %v\n", err)
		os.Exit(1)
	}
	return string(data) + "\n"
}

func ff(f float64) string {
	if f == math.Trunc(f) {
		return fmt.Sprintf("%.0f", f)
	}
	s := fmt.Sprintf("%.2f", f)
	s = strings.TrimRight(s, "0")
	return s
}

func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

func maxI(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func condF(c bool, t, f float64) float64 {
	if c {
		return t
	}
	return f
}
