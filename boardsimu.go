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

	machine.GPIOGet = func(pin uint8) bool {
		return getGPIO(pin)
	}

	machine.SPIConfigure = func(bus uint8, sck uint8, mosi uint8, miso uint8) {
		configureSPI(bus, sck, mosi, miso)
	}

	machine.SPITransfer = func(id uint8, w byte) byte {
		return transferSPI(id, w)
	}
}

//go:export boardsimu_gpio_set
func setGPIO(pin uint8, value bool)

//go:export boardsimu_gpio_get
func getGPIO(pin uint8) bool

//go:export boardsimu_gpio_configure
func configureGPIO(pin uint8, mode machine.GPIOMode)

//go:export boardsimu_spi_configure
func configureSPI(bus uint8, sck uint8, mosi uint8, miso uint8)

//go:export boardsimu_spi_transfer
func transferSPI(id uint8, w byte) byte
