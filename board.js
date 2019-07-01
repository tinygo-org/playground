'use strict';

// This file emulates a hardware board with an MCU and a set of external
// devices (LEDs etc.).


// Initial set of boards. It will be extended after boards.json has been loaded.
var boards = {
  console: {
    name: 'console',
    humanName: 'Console',
    example: 'hello',
    devices: [],
  }
};

// A pin is one GPIO pin of a chip. It can be an input or an output and when it
// is an output, it can be low or high. It is used for the simplest peripherals
// (LEDs etc.).
class Pin {
  constructor(board, number) {
    this.board = board;
    this.number = number;
    this.mode = 'input';
    this.high = false;
    this.devices = new Set();
  }

  // Set the pin mode: 'input' or 'output'.
  setMode(mode) {
    this.mode = mode;
    this.update();
  }

  // Update whether this pin is high or low. This is only a valid operation when
  // the mode is set to 'output'.
  set(high) {
    if (this.mode != 'output') {
      console.warn('set output while mode is', this.mode);
    }
    this.high = high ? true : false;
    this.update();
  }

  // Sense whether an input device has set this high or low, or floating. It
  // returns true (high), false (low), or null (floating).
  get() {
    if (this.mode != 'input') {
      console.warn('read pin while mode is', this.mode);
      return this.high;
    }
    let value = null;
    for (let device of this.devices) {
      if ('sensePin' in device) {
        let v = device.sensePin(this);
        if (v === true || v === false) {
          if (value == true || value == false) {
            console.warn('pin has more than one input:', this.number);
            return value;
          }
          value = v;
        }
      }
    }
    if (value !== true && value !== false) {
      console.warn('reading a floating pin:', this.number);
      return null;
    }
    return value ? true : false;
  }

  // Notify this device on each change to this pin.
  attach(device) {
    this.devices.add(device);
  }

  // Update all attached devices. Used when any of the properties change.
  update() {
    for (let device of this.devices) {
      device.update();
    }
  }

  // Whether this pin is currently high. Returns true, false, or null (when
  // floating).
  isHigh() {
    if (this.mode == 'output') {
      return this.high;
    } else if (this.mode == 'input') {
      return this.get() === true;
    }
    return null;
  }

  // Whether this pin is currently low.
  isLow() {
    if (this.mode == 'output') {
      return !this.high;
    } else if (this.mode == 'input') {
      return this.get() === false;
    }
    return null;
  }

  // Whether this is a source, that is, whether current can flow from this pin
  // (like VCC).
  isSource() {
    return this.mode == 'output' && this.high;
  }

  // Whether this is a sink, that is, whether current can flow into this pin
  // (like GND).
  isSink() {
    return this.mode == 'output' && !this.high;
  }
}

// An SPI device emulates a hardware SPI peripheral. It can send/receive one byte at a time.
class SPI {
  constructor(board, number) {
    this.board = board;
    this.number = number;
    this.sck = null;
    this.mosi = null;
    this.miso = null;
  }

  configure(sck, mosi, miso) {
    this.sck = sck;
    this.mosi = mosi;
    this.miso = miso;
  }

  // Send/receive a single byte, communicating with all connected devices.
  transfer(send) {
    let recv = 0;
    for (let device of this.sck.devices) {
      if ('transferSPI' in device) {
        recv = device.transferSPI(this.sck, this.mosi, this.miso, send);
      }
    }
    return recv;
  }
}

class Board {
  constructor(config, container) {
    this.config = config;
    this.container = container;
    this.pins = {};
    this.spiBuses = {};

    container.innerHTML = '';
    for (let deviceConfig of config.devices) {
      let device;
      let deviceContainer = document.createElement('div');
      deviceContainer.classList.add('device');
      deviceContainer.innerHTML = '<div class="device-content"></div><div class="device-name"></div>';
      deviceContainer.querySelector('.device-name').textContent = deviceConfig.name;
      container.appendChild(deviceContainer);
      let deviceContent = deviceContainer.querySelector('.device-content');
      if (deviceConfig.type == 'led') {
        device = new LED(this, deviceConfig, deviceContent);
      } else if (deviceConfig.type == 'epd2in13') {
        device = new EPD2IN13(this, deviceConfig, deviceContent);
      } else if (deviceConfig.type == 'epd2in13x') {
        device = new EPD2IN13X(this, deviceConfig, deviceContent);
      } else {
        console.warn('unknown device type:', deviceConfig);
        continue;
      }
      device.update();
    }
  }

  // Get one of the pins attached to the chip on this board.
  getPin(number) {
    if (!(number in this.pins)) {
      this.pins[number] = new Pin(this, number);
    }
    return this.pins[number];
  }

  // Get (or create) a new SPI bus attached to the chip of this board.
  getSPI(number) {
    if (!(number in this.spiBuses)) {
      this.spiBuses[number] = new SPI(this, number);
    }
    return this.spiBuses[number];
  }

  get name() {
    return this.config.name;
  }
}

// updateBoards updates the dropdown menu. This must be done after loading the
// boards or updating the target selection.
function updateBoards(selectedTarget) {
  let dropdown = document.querySelector('#target > .dropdown-menu');
  dropdown.innerHTML = '';
  for (let name in boards) {
    let board = boards[name];
    let item = document.createElement('a');
    item.textContent = board.humanName;
    item.classList.add('dropdown-item');
    if (name == selectedTarget) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = name;
    dropdown.appendChild(item);
  }
  for (let item of document.querySelectorAll('#target > .dropdown-menu > .dropdown-item')) {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      let boardConfig = boards[item.dataset.name];
      document.querySelector('#target > button').textContent = boardConfig.humanName;
      updateBoards(boardConfig.name);
      setTarget(boardConfig.name);
    });
  }
}

function loadBoards() {
  fetch('boards.json').then((response) => {
    response.json().then((data) => {
      Object.assign(boards, data);
      updateBoards(defaultTarget);
    });
  }).catch((reason) => {
    // TODO
    console.error(reason);
  });
}
