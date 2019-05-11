package boardsimu

import (
	"machine"
)

func SetupDevice(name string) {
	machine.BUTTON = 13
	machine.BUTTON1 = 13
	machine.BUTTON2 = 14
	machine.BUTTON3 = 15
	machine.BUTTON4 = 16

	machine.LED = 17
	machine.LED1 = 17
	machine.LED2 = 18
	machine.LED3 = 19
	machine.LED4 = 20

	machine.GPIOConfigure = func(pin uint8, config machine.GPIOConfig) {
		configureGPIO(pin, config.Mode)
	}

	machine.GPIOSet = func(pin uint8, value bool) {
		setGPIO(pin, value)
	}
}

//go:export boardsimu_gpio_set
func setGPIO(pin uint8, value bool)

//go:export boardsimu_gpio_configure
func configureGPIO(pin uint8, mode machine.GPIOMode)
