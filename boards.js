export { boards };

const exampleHelloGo = `package main

import (
	"fmt"
)

func main() {
	fmt.Println("Hello, Go")
}`;

const exampleHelloTinyGo = `package main

import (
	"fmt"
)

func main() {
	fmt.Println("Hello, TinyGo")
}`;

const exampleBlinky1 = `package main

import (
	"machine"
	"time"
)

const led = machine.LED

func main() {
	println("Hello, TinyGo")
	led.Configure(machine.PinConfig{Mode: machine.PinOutput})
	for {
		led.Low()
		time.Sleep(time.Second)

		led.High()
		time.Sleep(time.Second)
	}
}`;

const exampleMicrobitBlink = `package main

import (
	"machine"
	"time"
)

func main() {
	ledcol := machine.LED_COL_1
	ledcol.Configure(machine.PinConfig{Mode: machine.PinOutput})
	ledcol.Low()

	ledrow := machine.LED_ROW_1
	ledrow.Configure(machine.PinConfig{Mode: machine.PinOutput})
	for {
		ledrow.Low()
		time.Sleep(time.Millisecond * 500)

		ledrow.High()
		time.Sleep(time.Millisecond * 500)
	}
}`;

const exampleGopherBadge = `// See: https://gopherbadge.com/

package main

import (
	"image/color"
	"machine"
	"strings"
	"time"

	"tinygo.org/x/drivers/pixel"
	"tinygo.org/x/drivers/st7789"
	"tinygo.org/x/drivers/ws2812"
	"tinygo.org/x/tinygl-font"
	"tinygo.org/x/tinygl-font/roboto"
)

var colors = make([]color.RGBA, 2)

func main() {
	go blinkEyes()

	// configure the display
	machine.SPI0.Configure(machine.SPIConfig{
		Mode:      3,
		SCK:       machine.SPI0_SCK_PIN,
		SDO:       machine.SPI0_SDO_PIN,
		SDI:       machine.SPI0_SDI_PIN,
		Frequency: 62_500_000, // 62.5MHz
	})
	display := st7789.New(machine.SPI0,
		machine.TFT_RST,       // TFT_RESET
		machine.TFT_WRX,       // TFT_DC
		machine.TFT_CS,        // TFT_CS
		machine.TFT_BACKLIGHT) // TFT_LITE
	display.Configure(st7789.Config{
		Rotation: st7789.ROTATION_270,
		Height:   320,
	})

	// define some constants
	type T = pixel.RGB565BE
	black := pixel.NewColor[T](0, 0, 0)
	white := pixel.NewColor[T](255, 255, 255)

	// show pressed buttons
	buf := pixel.NewImage[T](320, 28)
	labels := []string{"A", "B", "up", "down", "left", "right"}
	buttons := []machine.Pin{machine.BUTTON_A, machine.BUTTON_B, machine.BUTTON_UP, machine.BUTTON_DOWN, machine.BUTTON_LEFT, machine.BUTTON_RIGHT}
	for _, button := range buttons {
		button.Configure(machine.PinConfig{Mode: machine.PinInputPullup})
	}
	for {
		var pressed []string
		for i, button := range buttons {
			if !button.Get() {
				pressed = append(pressed, labels[i])
			}
		}
		buf.FillSolidColor(black)
		text := "button pressed: " + strings.Join(pressed, " ")
		if len(pressed) == 0 {
			text += "(none)"
		}
		font.Draw(roboto.Regular24, text, 4, 20, white, buf)
		display.DrawBitmap(0, 0, buf)
		display.Display()
		time.Sleep(time.Second / 8)
	}
}

func blinkEyes() {
	machine.NEOPIXELS.Configure(machine.PinConfig{Mode: machine.PinOutput})
	ws := ws2812.New(machine.NEOPIXELS)
	for {
		colors[0] = color.RGBA{R: 255}
		colors[1] = color.RGBA{B: 255}
		ws.WriteColors(colors)
		time.Sleep(time.Second / 2)

		colors[0] = color.RGBA{B: 255}
		colors[1] = color.RGBA{R: 255}
		ws.WriteColors(colors)
		time.Sleep(time.Second / 2)
	}
}`;

const exampleRGBLED = `package main

import (
	"machine"
	"time"
)

var leds = []machine.Pin{machine.LED_RED, machine.LED_GREEN, machine.LED_BLUE}

func main() {
	println("Hello, TinyGo")
	for _, led := range leds {
		led.Configure(machine.PinConfig{Mode: machine.PinOutput})
		led.High()
	}
	for {
		for _, led := range leds {
			led.Low()
			time.Sleep(time.Second)
			led.High()
		}
	}
}`;

// List of boards to show in the menu. See parts/*.json.
const boards = {
	'console-go': {
		humanName: 'Console (Go)',
		location: 'parts/console.json',
		compiler: 'go',
		code: exampleHelloGo,
	},
	'console': {
		humanName: 'Console (TinyGo)',
		location: 'parts/console.json',
		compiler: 'tinygo',
		code: exampleHelloTinyGo,
	},
	'arduino': {
		humanName: 'Arduino Uno',
		location: 'parts/arduino.json',
		compiler: 'tinygo',
		code: exampleBlinky1,
	},
	'arduino-nano33': {
		humanName: 'Arduino Nano 33 IoT',
		location: 'parts/arduino-nano33.json',
		compiler: 'tinygo',
		code: exampleBlinky1,
	},
	'circuitplay-bluefruit': {
		humanName: 'Circuit Playground Bluefruit',
		location: 'parts/circuitplay-bluefruit.json',
		compiler: 'tinygo',
		code: exampleBlinky1,
	},
	'circuitplay-express': {
		humanName: 'Circuit Playground Express',
		location: 'parts/circuitplay-express.json',
		compiler: 'tinygo',
		code: exampleBlinky1,
	},
	'gopher-badge': {
		humanName: 'Gopher Badge',
		location: 'parts/gopher-badge.json',
		compiler: 'tinygo',
		code: exampleGopherBadge,
	},
	'hifive1b': {
		humanName: 'HiFive1 rev B',
		location: 'parts/hifive1b.json',
		compiler: 'tinygo',
		code: exampleRGBLED,
	},
	'microbit': {
		humanName: 'BBC micro:bit v1',
		location: 'parts/microbit.json',
		compiler: 'tinygo',
		code: exampleMicrobitBlink,
	},
	'reelboard': {
		humanName: 'Phytec reel board',
		location: 'parts/reelboard.json',
		compiler: 'tinygo',
		code: exampleRGBLED,
	},
	'pinetime': {
		humanName: 'PineTime',
		location: 'parts/pinetime.json',
		compiler: 'tinygo',
		code: exampleBlinky1,
	},
};
