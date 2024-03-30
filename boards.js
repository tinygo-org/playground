export { examples, boardNames };

const exampleHello = `package main

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

// A list of source code samples used for each target. This is the default code
// set for a given configuration.
const examples = {
	hello: exampleHello,
	blinky1: exampleBlinky1,
	microbitblink: exampleMicrobitBlink,
	rgbled: exampleRGBLED,
};

// List of boards to show in the menu. See parts/*.json.
const boardNames = {
	'console': 'Console',
	'arduino': 'Arduino Uno',
	'arduino-nano33': 'Arduino Nano 33 IoT',
	'circuitplay-bluefruit': 'Circuit Playground Bluefruit',
	'circuitplay-express': 'Circuit Playground Express',
	'hifive1b': 'HiFive1 rev B',
	'microbit': 'BBC micro:bit v1',
	'reelboard': 'Phytec reel board',
	'pinetime': 'PineTime',
};
