package main

import (
"encoding/json"
"encoding/xml"
"fmt"
"math"
"strings"
"testing"
)

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

func TestValidate_NameRequired(t *testing.T) {
err := validate(BoardConfig{PinsTop: 5})
if err == nil || !strings.Contains(err.Error(), "-name") {
t.Fatalf("expected name-required error, got %v", err)
}
}

func TestValidate_NoPins(t *testing.T) {
err := validate(BoardConfig{Name: "x"})
if err == nil || !strings.Contains(err.Error(), "pins") {
t.Fatalf("expected no-pins error, got %v", err)
}
}

func TestValidate_InvalidUSBSide(t *testing.T) {
err := validate(BoardConfig{Name: "x", PinsTop: 1, USBSide: "front", HasUSB: true})
if err == nil || !strings.Contains(err.Error(), "invalid -usb") {
t.Fatalf("expected invalid usb error, got %v", err)
}
}

func TestValidate_InvalidOrientation(t *testing.T) {
err := validate(BoardConfig{Name: "x", PinsTop: 1, Orientation: "diagonal"})
if err == nil || !strings.Contains(err.Error(), "orientation") {
t.Fatalf("expected orientation error, got %v", err)
}
}

func TestValidate_NegativePins(t *testing.T) {
err := validate(BoardConfig{Name: "x", PinsTop: -1, Orientation: "horizontal"})
if err == nil || !strings.Contains(err.Error(), "pins-top") {
t.Fatalf("expected negative-pins error, got %v", err)
}
}

func TestValidate_NegativeWidth(t *testing.T) {
err := validate(BoardConfig{Name: "x", PinsTop: 5, Orientation: "horizontal", Width: -10})
if err == nil || !strings.Contains(err.Error(), "-width") {
t.Fatalf("expected negative width error, got %v", err)
}
}

func TestValidate_NegativeHeight(t *testing.T) {
err := validate(BoardConfig{Name: "x", PinsTop: 5, Orientation: "horizontal", Height: -5})
if err == nil || !strings.Contains(err.Error(), "-height") {
t.Fatalf("expected negative height error, got %v", err)
}
}

func TestValidate_ValidConfigs(t *testing.T) {
cases := []struct {
name string
cfg  BoardConfig
}{
{
name: "minimal",
cfg:  BoardConfig{Name: "b", PinsBottom: 4, Orientation: "horizontal"},
},
{
name: "all sides",
cfg: BoardConfig{
Name: "b", PinsTop: 5, PinsBottom: 5, PinsLeft: 3, PinsRight: 3,
Orientation: "horizontal",
},
},
{
name: "with usb",
cfg: BoardConfig{
Name: "b", PinsTop: 10, PinsBottom: 10,
HasUSB: true, USBSide: "left",
Orientation: "vertical",
},
},
{
name: "explicit size",
cfg: BoardConfig{
Name: "b", PinsTop: 5, Orientation: "horizontal",
Width: 60, Height: 30,
},
},
}
for _, tc := range cases {
t.Run(tc.name, func(t *testing.T) {
if err := validate(tc.cfg); err != nil {
t.Fatalf("unexpected error: %v", err)
}
})
}
}

// ---------------------------------------------------------------------------
// assignPins
// ---------------------------------------------------------------------------

func TestAssignPins_SingleSide(t *testing.T) {
cfg := BoardConfig{PinsBottom: 4}
pins, numGPIO := assignPins(cfg)
if numGPIO != 4 {
t.Fatalf("expected 4 GPIOs, got %d", numGPIO)
}
if len(pins) != 4 {
t.Fatalf("expected 4 pins, got %d", len(pins))
}
for i, p := range pins {
if p.Side != "bottom" {
t.Errorf("pin %d: expected side bottom, got %s", i, p.Side)
}
if p.Type != "gpio" {
t.Errorf("pin %d: expected type gpio, got %s", i, p.Type)
}
if p.GPIONum != i {
t.Errorf("pin %d: expected GPIONum %d, got %d", i, i, p.GPIONum)
}
}
}

func TestAssignPins_GNDInsertion(t *testing.T) {
// With 7 pins on one side, after 5 GPIOs a GND should be inserted.
// Expect: GP0 GP1 GP2 GP3 GP4 GND#1 GP5
cfg := BoardConfig{PinsTop: 7}
pins, numGPIO := assignPins(cfg)
if numGPIO != 6 {
t.Fatalf("expected 6 GPIOs, got %d", numGPIO)
}
if len(pins) != 7 {
t.Fatalf("expected 7 pins, got %d", len(pins))
}
if pins[5].Type != "gnd" {
t.Errorf("expected pin 5 to be GND, got %s (%s)", pins[5].Type, pins[5].Name)
}
if pins[5].Title != "GND" {
t.Errorf("expected GND title, got %q", pins[5].Title)
}
}

func TestAssignPins_USBSidePowerPins(t *testing.T) {
cfg := BoardConfig{
PinsLeft: 8,
HasUSB:   true,
USBSide:  "left",
}
pins, _ := assignPins(cfg)
if len(pins) < 3 {
t.Fatalf("expected at least 3 pins, got %d", len(pins))
}
if pins[0].Name != "VBUS" || pins[0].Type != "vcc" {
t.Errorf("first pin should be VBUS, got %s (%s)", pins[0].Name, pins[0].Type)
}
if pins[1].Type != "gnd" || pins[1].Title != "GND" {
t.Errorf("second pin should be GND, got %s (%s)", pins[1].Name, pins[1].Type)
}
if pins[2].Name != "3V3" || pins[2].Type != "3v3" {
t.Errorf("third pin should be 3V3, got %s (%s)", pins[2].Name, pins[2].Type)
}
// Remaining 5 should be GPIO pins.
gpioCount := 0
for _, p := range pins[3:] {
if p.Type == "gpio" {
gpioCount++
}
}
if gpioCount != 5 {
t.Errorf("expected 5 GPIO pins after power, got %d", gpioCount)
}
}

func TestAssignPins_MultipleSides(t *testing.T) {
cfg := BoardConfig{
PinsTop:    3,
PinsRight:  2,
PinsBottom: 3,
PinsLeft:   2,
}
pins, numGPIO := assignPins(cfg)
if numGPIO != 10 {
t.Fatalf("expected 10 GPIOs, got %d", numGPIO)
}
gpios := 0
for _, p := range pins {
if p.Type == "gpio" {
gpios++
}
}
if gpios != 10 {
t.Errorf("expected 10 GPIOs, got %d", gpios)
}
// Verify side order: top, right, bottom, left
sides := make(map[string]int)
for _, p := range pins {
sides[p.Side]++
}
if sides["top"] != 3 || sides["right"] != 2 || sides["bottom"] != 3 || sides["left"] != 2 {
t.Errorf("unexpected side distribution: %v", sides)
}
}

func TestAssignPins_GPIONumberingSequential(t *testing.T) {
cfg := BoardConfig{PinsTop: 4, PinsBottom: 4}
pins, _ := assignPins(cfg)
gpioNum := 0
for _, p := range pins {
if p.Type == "gpio" {
if p.GPIONum != gpioNum {
t.Errorf("expected GPIO%d, got GPIO%d (pin %s)", gpioNum, p.GPIONum, p.Name)
}
gpioNum++
}
}
}

// ---------------------------------------------------------------------------
// computeLayout
// ---------------------------------------------------------------------------

func TestComputeLayout_MinimumSize(t *testing.T) {
cfg := BoardConfig{Name: "x", PinsBottom: 2, Orientation: "horizontal"}
lay := computeLayout(cfg)
if lay.BoardW < minBoardDim {
t.Errorf("expected min width >= %.1f, got %.1f", minBoardDim, lay.BoardW)
}
if lay.BoardH < minBoardDim {
t.Errorf("expected min height >= %.1f, got %.1f", minBoardDim, lay.BoardH)
}
}

func TestComputeLayout_PadDepth(t *testing.T) {
cfg := BoardConfig{Name: "x", PinsTop: 5, PinsBottom: 5, Orientation: "horizontal"}
lay := computeLayout(cfg)
// Board height should include top and bottom pad depths.
if lay.BoardH < 2*padDepth {
t.Errorf("expected board height >= 2*padDepth (%.2f), got %.2f", 2*padDepth, lay.BoardH)
}
}

func TestComputeLayout_ExplicitDimensions(t *testing.T) {
cfg := BoardConfig{
Name: "x", PinsTop: 5, PinsBottom: 5, Orientation: "horizontal",
Width: 60, Height: 30,
}
lay := computeLayout(cfg)
if lay.BoardW != 60 {
t.Errorf("expected width 60, got %.1f", lay.BoardW)
}
if lay.BoardH != 30 {
t.Errorf("expected height 30, got %.1f", lay.BoardH)
}
}

func TestComputeLayout_USB(t *testing.T) {
sides := []string{"left", "right", "top", "bottom"}
for _, side := range sides {
t.Run(side, func(t *testing.T) {
cfg := BoardConfig{
Name: "x", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: side,
}
lay := computeLayout(cfg)
if !lay.HasUSBRect {
t.Fatal("expected USB rect")
}
switch side {
case "left":
if lay.ViewX >= 0 {
t.Error("expected negative ViewX for left USB")
}
case "right":
if lay.ViewW <= lay.BoardW {
t.Error("expected ViewW > BoardW for right USB")
}
case "top":
if lay.ViewY >= 0 {
t.Error("expected negative ViewY for top USB")
}
case "bottom":
if lay.ViewH <= lay.BoardH {
t.Error("expected ViewH > BoardH for bottom USB")
}
}
})
}
}

func TestComputeLayout_LED(t *testing.T) {
cfg := BoardConfig{
Name: "x", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true,
}
lay := computeLayout(cfg)
if !lay.HasLED {
t.Fatal("expected LED")
}
if lay.LEDPin < 0 {
t.Fatal("expected valid LED pin")
}
if lay.LEDX < 0 || lay.LEDX+ledW > lay.BoardW {
t.Errorf("LED X out of board bounds: %.2f (board width %.2f)", lay.LEDX, lay.BoardW)
}
if lay.LEDY < 0 || lay.LEDY+ledH > lay.BoardH {
t.Errorf("LED Y out of board bounds: %.2f (board height %.2f)", lay.LEDY, lay.BoardH)
}
}

func TestComputeLayout_NoUSBNoLED(t *testing.T) {
cfg := BoardConfig{Name: "x", PinsBottom: 6, Orientation: "horizontal"}
lay := computeLayout(cfg)
if lay.HasUSBRect {
t.Error("expected no USB rect")
}
if lay.HasLED {
t.Error("expected no LED")
}
}

func TestComputeLayout_CornerGaps(t *testing.T) {
cfg := BoardConfig{
Name: "x", PinsTop: 4, PinsBottom: 4, PinsLeft: 4, PinsRight: 4,
Orientation: "horizontal",
}
lay := computeLayout(cfg)
expectedStartX := padDepth + cornerGap
if math.Abs(lay.TopStartX-expectedStartX) > 0.01 {
t.Errorf("expected TopStartX ~%.2f, got %.2f", expectedStartX, lay.TopStartX)
}
expectedStartY := padDepth + cornerGap
if math.Abs(lay.LeftStartY-expectedStartY) > 0.01 {
t.Errorf("expected LeftStartY ~%.2f, got %.2f", expectedStartY, lay.LeftStartY)
}
}

func TestComputeLayout_RectGndPassedThrough(t *testing.T) {
cfg := BoardConfig{Name: "x", PinsTop: 5, Orientation: "horizontal", RectGnd: true}
lay := computeLayout(cfg)
if !lay.RectGnd {
t.Error("expected RectGnd to be true in layout")
}
}

// ---------------------------------------------------------------------------
// generateSVG
// ---------------------------------------------------------------------------

func TestGenerateSVG_WellFormedXML(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)

d := xml.NewDecoder(strings.NewReader(svg))
for {
_, err := d.Token()
if err != nil {
if err.Error() == "EOF" {
break
}
t.Fatalf("invalid XML: %v", err)
}
}
}

func TestGenerateSVG_ContainsPCBRect(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsBottom: 6,
Orientation: "horizontal", PCBColor: "#ff0000",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if !strings.Contains(svg, `fill="#ff0000"`) {
t.Error("SVG should contain the PCB fill color")
}
}

func TestGenerateSVG_ContainsUSB(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 5, PinsBottom: 5,
Orientation: "horizontal", HasUSB: true, USBSide: "left", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if !strings.Contains(svg, `fill="#ccc"`) {
t.Error("SVG should contain USB port rectangle")
}
if !strings.Contains(svg, "USB port") {
t.Error("SVG should contain USB port comment")
}
}

func TestGenerateSVG_NoUSBWhenDisabled(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsBottom: 5,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if strings.Contains(svg, "USB port") {
t.Error("SVG should not contain USB port when disabled")
}
}

func TestGenerateSVG_ContainsLED(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if !strings.Contains(svg, `data-part="led"`) {
t.Error("SVG should contain LED element")
}
}

func TestGenerateSVG_NoLEDWhenDisabled(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsBottom: 5,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if strings.Contains(svg, `data-part="led"`) {
t.Error("SVG should not contain LED element when disabled")
}
}

func TestGenerateSVG_PinAttributes(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 3,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
for i := 0; i < 3; i++ {
attr := fmt.Sprintf(`data-pin="GP%d"`, i)
if !strings.Contains(svg, attr) {
t.Errorf("SVG should contain %s", attr)
}
}
}

func TestGenerateSVG_GNDPinTitle(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 7,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
if !strings.Contains(svg, `data-title="GND"`) {
t.Error("SVG should contain GND title attribute")
}
}

func TestGenerateSVG_USBSidePowerPins(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsLeft: 8,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
for _, name := range []string{"VBUS", "3V3"} {
attr := fmt.Sprintf(`data-pin="%s"`, name)
if !strings.Contains(svg, attr) {
t.Errorf("SVG should contain %s", attr)
}
}
}

func TestGenerateSVG_RectGndUsesSpecialPath(t *testing.T) {
cfgDefault := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 7,
Orientation: "horizontal", PCBColor: "#006837",
}
layDefault := computeLayout(cfgDefault)
svgDefault := generateSVG(cfgDefault, layDefault)

cfgRect := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 7,
Orientation: "horizontal", PCBColor: "#006837", RectGnd: true,
}
layRect := computeLayout(cfgRect)
svgRect := generateSVG(cfgRect, layRect)

// Default (RectGnd=false): GND pads use regular half-circle path (no "2.21").
if strings.Contains(svgDefault, "2.21") {
t.Error("default GND pads should use regular path (no 2.21)")
}
// RectGnd=true: GND pads use taller rectangular path (contains "2.21").
if !strings.Contains(svgRect, "2.21") {
t.Error("rect-gnd GND pads should use taller rectangular path (containing 2.21)")
}
}

func TestGenerateSVG_ViewBox(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
viewBox := fmt.Sprintf(`viewBox="0 0 %s %s"`, ff(lay.ViewW), ff(lay.ViewH))
if !strings.Contains(svg, viewBox) {
t.Errorf("SVG should contain viewBox %q", viewBox)
}
}

func TestGenerateSVG_AllFourSides(t *testing.T) {
cfg := BoardConfig{
Name: "test", HumanName: "Test",
PinsTop: 3, PinsBottom: 3, PinsLeft: 3, PinsRight: 3,
Orientation: "horizontal", PCBColor: "#006837",
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
for _, side := range []string{"top", "bottom", "left", "right"} {
comment := fmt.Sprintf("pads on the %s", side)
if !strings.Contains(svg, comment) {
t.Errorf("SVG should contain pads section for %s", side)
}
}
}

// ---------------------------------------------------------------------------
// generateJSON
// ---------------------------------------------------------------------------

func TestGenerateJSON_ValidJSON(t *testing.T) {
cfg := BoardConfig{
Name: "test-board", HumanName: "Test Board",
PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
t.Fatalf("generated JSON is invalid: %v", err)
}
}

func TestGenerateJSON_Fields(t *testing.T) {
cfg := BoardConfig{
Name: "test-board", HumanName: "Test Board",
PinsTop: 5, PinsBottom: 5,
Orientation: "horizontal", FirmwareFormat: "hex",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
t.Fatalf("invalid JSON: %v", err)
}
if parsed.Name != "test-board" {
t.Errorf("expected name test-board, got %s", parsed.Name)
}
if parsed.HumanName != "Test Board" {
t.Errorf("expected humanName 'Test Board', got %s", parsed.HumanName)
}
if parsed.FirmwareFormat != "hex" {
t.Errorf("expected firmwareFormat hex, got %s", parsed.FirmwareFormat)
}
if parsed.SVG != "test-board.svg" {
t.Errorf("expected svg test-board.svg, got %s", parsed.SVG)
}
if parsed.MainPart != "mcu" {
t.Errorf("expected mainPart mcu, got %s", parsed.MainPart)
}
}

func TestGenerateJSON_MCUPart(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsBottom: 4,
Orientation: "horizontal", FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

if len(parsed.Parts) < 1 {
t.Fatal("expected at least one part")
}
mcu := parsed.Parts[0]
if mcu.ID != "mcu" || mcu.Type != "mcu" {
t.Errorf("expected mcu part, got id=%s type=%s", mcu.ID, mcu.Type)
}
var pinMap map[string]int
if err := json.Unmarshal(mcu.Pins, &pinMap); err != nil {
t.Fatalf("could not parse MCU pins: %v", err)
}
if len(pinMap) != lay.NumGPIO {
t.Errorf("expected %d GPIO entries in MCU pins, got %d", lay.NumGPIO, len(pinMap))
}
for i := 0; i < lay.NumGPIO; i++ {
key := fmt.Sprintf("GPIO%d", i)
val, ok := pinMap[key]
if !ok {
t.Errorf("missing MCU pin %s", key)
} else if val != i {
t.Errorf("expected pin %s=%d, got %d", key, i, val)
}
}
}

func TestGenerateJSON_LEDPart(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

if len(parsed.Parts) < 2 {
t.Fatal("expected at least 2 parts (mcu + led)")
}
led := parsed.Parts[1]
if led.ID != "led" || led.Type != "led" {
t.Errorf("expected led part, got id=%s type=%s", led.ID, led.Type)
}
if led.HumanName != "LED" {
t.Errorf("expected humanName LED, got %s", led.HumanName)
}
}

func TestGenerateJSON_NoLEDPart(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsBottom: 4,
Orientation: "horizontal", FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

if len(parsed.Parts) != 1 {
t.Errorf("expected 1 part (mcu only), got %d", len(parsed.Parts))
}
}

func TestGenerateJSON_Wires(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsBottom: 4,
Orientation: "horizontal", FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

gpioWires := 0
for _, w := range parsed.Wires {
if strings.HasPrefix(w.From, "mcu.GPIO") {
gpioWires++
}
}
if gpioWires != lay.NumGPIO {
t.Errorf("expected %d GPIO wires, got %d", lay.NumGPIO, gpioWires)
}
}

func TestGenerateJSON_PowerWires(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsLeft: 8,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

hasVCC := false
hasGND := false
for _, w := range parsed.Wires {
if w.From == "vcc" && w.To == "VBUS" {
hasVCC = true
}
if w.From == "gnd" {
hasGND = true
}
}
if !hasVCC {
t.Error("expected vcc wire for VBUS")
}
if !hasGND {
t.Error("expected gnd wire")
}
}

func TestGenerateJSON_LEDWire(t *testing.T) {
cfg := BoardConfig{
Name: "b", HumanName: "B", PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, FirmwareFormat: "uf2",
}
lay := computeLayout(cfg)
jsonStr := generateJSON(cfg, lay)

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)

hasLEDWire := false
for _, w := range parsed.Wires {
if w.To == "led.anode" {
hasLEDWire = true
expected := fmt.Sprintf("mcu.GPIO%d", lay.LEDPin)
if w.From != expected {
t.Errorf("LED wire from %s, expected %s", w.From, expected)
}
}
}
if !hasLEDWire {
t.Error("expected LED anode wire")
}
}

// ---------------------------------------------------------------------------
// ff (float formatter)
// ---------------------------------------------------------------------------

func TestFF(t *testing.T) {
cases := []struct {
in   float64
want string
}{
{0, "0"},
{1, "1"},
{10, "10"},
{1.5, "1.5"},
{1.55, "1.55"},
{1.50, "1.5"},
{2.54, "2.54"},
{-1.3, "-1.3"},
{100.0, "100"},
{3.10, "3.1"},
}
for _, tc := range cases {
got := ff(tc.in)
if got != tc.want {
t.Errorf("ff(%v) = %q, want %q", tc.in, got, tc.want)
}
}
}

// ---------------------------------------------------------------------------
// titleCase
// ---------------------------------------------------------------------------

func TestTitleCase(t *testing.T) {
cases := []struct {
in, want string
}{
{"hello world", "Hello World"},
{"my pico board", "My Pico Board"},
{"a", "A"},
{"", ""},
{"already Title", "Already Title"},
}
for _, tc := range cases {
got := titleCase(tc.in)
if got != tc.want {
t.Errorf("titleCase(%q) = %q, want %q", tc.in, got, tc.want)
}
}
}

// ---------------------------------------------------------------------------
// maxI
// ---------------------------------------------------------------------------

func TestMaxI(t *testing.T) {
if maxI(3, 5) != 5 {
t.Error("maxI(3, 5) should be 5")
}
if maxI(5, 3) != 5 {
t.Error("maxI(5, 3) should be 5")
}
if maxI(4, 4) != 4 {
t.Error("maxI(4, 4) should be 4")
}
}

// ---------------------------------------------------------------------------
// condF
// ---------------------------------------------------------------------------

func TestCondF(t *testing.T) {
if condF(true, 1.0, 2.0) != 1.0 {
t.Error("condF(true, ...) should return first value")
}
if condF(false, 1.0, 2.0) != 2.0 {
t.Error("condF(false, ...) should return second value")
}
}

// ---------------------------------------------------------------------------
// Integration: full pipeline produces consistent SVG+JSON
// ---------------------------------------------------------------------------

func TestIntegration_PicoLikeBoard(t *testing.T) {
cfg := BoardConfig{
Name: "pico-test", HumanName: "Pico Test",
PinsTop: 20, PinsBottom: 20,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, PCBColor: "#006837", FirmwareFormat: "uf2",
}
if err := validate(cfg); err != nil {
t.Fatalf("validation failed: %v", err)
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
jsonStr := generateJSON(cfg, lay)

// SVG is well-formed XML.
d := xml.NewDecoder(strings.NewReader(svg))
for {
_, err := d.Token()
if err != nil {
if err.Error() == "EOF" {
break
}
t.Fatalf("SVG is not valid XML: %v", err)
}
}

// JSON is valid.
var parsed BoardJSON
if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
t.Fatalf("JSON is invalid: %v", err)
}

// Every GPIO wire references a pin that exists in the SVG.
for _, w := range parsed.Wires {
if strings.HasPrefix(w.From, "mcu.GPIO") && !strings.Contains(w.To, ".") {
attr := fmt.Sprintf(`data-pin="%s"`, w.To)
if !strings.Contains(svg, attr) {
t.Errorf("wire to %s but SVG has no %s", w.To, attr)
}
}
}

// LED anode wire exists.
hasLED := false
for _, w := range parsed.Wires {
if w.To == "led.anode" {
hasLED = true
}
}
if !hasLED {
t.Error("expected LED wire in JSON")
}
if !strings.Contains(svg, `data-part="led"`) {
t.Error("expected LED in SVG")
}
}

func TestIntegration_MinimalBoard(t *testing.T) {
cfg := BoardConfig{
Name: "minimal", HumanName: "Minimal",
PinsBottom: 4,
Orientation: "horizontal", PCBColor: "#006837", FirmwareFormat: "uf2",
}
if err := validate(cfg); err != nil {
t.Fatalf("validation failed: %v", err)
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
jsonStr := generateJSON(cfg, lay)

if strings.Contains(svg, "USB port") {
t.Error("minimal board should not have USB")
}
if strings.Contains(svg, `data-part="led"`) {
t.Error("minimal board should not have LED")
}

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)
if len(parsed.Parts) != 1 {
t.Errorf("expected 1 part for minimal board, got %d", len(parsed.Parts))
}
}

func TestIntegration_VerticalBoard(t *testing.T) {
cfg := BoardConfig{
Name: "vert", HumanName: "Vertical",
PinsLeft: 15, PinsRight: 15,
Orientation: "vertical", HasUSB: true, USBSide: "top",
HasLED: true, PCBColor: "#006837", FirmwareFormat: "uf2",
}
if err := validate(cfg); err != nil {
t.Fatalf("validation failed: %v", err)
}
lay := computeLayout(cfg)
svg := generateSVG(cfg, lay)
jsonStr := generateJSON(cfg, lay)

if !strings.Contains(svg, "pads on the left") {
t.Error("expected left pads in SVG")
}
if !strings.Contains(svg, "pads on the right") {
t.Error("expected right pads in SVG")
}

var parsed BoardJSON
json.Unmarshal([]byte(jsonStr), &parsed)
if parsed.Name != "vert" {
t.Errorf("expected name 'vert', got %s", parsed.Name)
}
}

func TestIntegration_FixedSizeWithRectGnd(t *testing.T) {
cfg := BoardConfig{
Name: "wide", HumanName: "Wide",
PinsTop: 10, PinsBottom: 10,
Orientation: "horizontal", HasUSB: true, USBSide: "left",
HasLED: true, PCBColor: "#006837", FirmwareFormat: "uf2",
Width: 60, Height: 30, RectGnd: true,
}
if err := validate(cfg); err != nil {
t.Fatalf("validation failed: %v", err)
}
lay := computeLayout(cfg)
if lay.BoardW != 60 || lay.BoardH != 30 {
t.Errorf("expected 60x30, got %.0fx%.0f", lay.BoardW, lay.BoardH)
}

svg := generateSVG(cfg, lay)
if !strings.Contains(svg, "2.21") {
t.Error("rect-gnd should have taller rectangular GND paths (containing 2.21)")
}
}
