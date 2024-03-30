export { boards };

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

// List of boards to show in the menu. See parts/*.json.
const boards = {
	'console': {
		humanName: 'Console',
		code: exampleHello,
	},
	'arduino': {
		humanName: 'Arduino Uno',
		code: exampleBlinky1,
	},
	'arduino-nano33': {
		humanName: 'Arduino Nano 33 IoT',
		code: exampleBlinky1,
	},
	'circuitplay-bluefruit': {
		humanName: 'Circuit Playground Bluefruit',
		code: exampleBlinky1,
	},
	'circuitplay-express': {
		humanName: 'Circuit Playground Express',
		code: exampleBlinky1,
	},
	'hifive1b': {
		humanName: 'HiFive1 rev B',
		code: exampleRGBLED,
	},
	'microbit': {
		humanName: 'BBC micro:bit v1',
		code: exampleMicrobitBlink,
	},
	'reelboard': {
		humanName: 'Phytec reel board',
		code: exampleRGBLED,
	},
	'pinetime': {
		humanName: 'PineTime',
		code: exampleBlinky1,
	},
};
