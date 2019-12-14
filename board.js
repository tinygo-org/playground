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
  constructor(part, id) {
    this.part = part;
    this.id = id;
    this.mode = 'input';
    this.high = false;
    this.net = new Net(this);
    this.spiSlave = null;
    this.ws2812Listener = null;
  }

  // A human readable name that can be displayed in the UI.
  get name() {
    return this.part.name + '.' + this.id;
  }

  // Set the pin mode: 'input' or 'output'. It must be one of these two.
  setMode(mode) {
    if (mode !== 'input' && mode !== 'output') {
      throw 'mode should be input or output, got: ' + mode;
    }
    this.mode = mode;
    this.net.update();
  }

  // Update whether this pin is high or low. This is only a valid operation when
  // the mode is set to 'output'.
  set(high) {
    if (this.mode != 'output') {
      console.warn('set output while mode is', this.mode);
    }
    this.high = high ? true : false;
    this.net.update();
  }

  // Sense whether an input device has set this high or low, or floating. It
  // returns true (high), false (low), or null (floating).
  get() {
    if (this.mode == 'output') {
      console.warn('read output pin:', this.name);
      return this.high;
    }

    let value = this.net.state;
    if (value === 'floating') {
      console.warn('reading a floating pin:', this.name);
      // Act like a floating pin by returning a random value.
      return Math.random() < 0.5;
    } else if (value === 'source') {
      return true;
    } else if (value === 'sink') {
      return false;
    } else {
      console.error('unknown net state:', this.name);
      return false;
    }
  }

  // Connect the two Pin objects together in a net.
  attach(pin) {
    this.net.attach(pin);
  }

  // Set the SPI slave peripheral (SPISlave). It should only be set for the sck
  // pin. By setting the SPI slave, the SPI master (SPIMaster) can find
  // connected slaves.
  setSPISlave(spi) {
    if (this.spiSlave !== null) {
      throw 'Pin.setSPISlave: SPI slave already set!';
    }
    this.spiSlave = spi;
  }

  setWS2812Listener(part) {
    if (this.ws2812Listener !== null) {
      throw 'Pin.setWS2812Listener: listener already set!';
    }
    this.ws2812Listener = part;
  }

  // Whether this pin is currently high. Returns true, false, or null (when
  // floating).
  isHigh() {
    return this.isSource();
  }

  // Whether this pin is currently low.
  isLow() {
    return this.isSink();
  }

  // Whether this is a source, that is, whether current can flow from this pin
  // (like VCC).
  isSource() {
    return this.net.isSource();
  }

  // Whether this is a sink, that is, whether current can flow into this pin
  // (like GND).
  isSink() {
    return this.net.isSink();
  }

  get connected() {
    return this.net.pins.size > 1;
  }
}

// A net is a collection of pins that are connected together.
class Net {
  constructor(pin) {
    // Note: this net should only be constructed while creating a Pin, and the
    // Pin should set this net as its net.
    this.pins = new Set([pin]);
    this.state = 'floating';
  }

  attach(pin) {
    // Merge the net of the pin into this net.
    let newpins = pin.net.pins;
    pin.net.pins = null; // make sure this net is not used anymore
    for (let p of newpins) {
      this.pins.add(p);
      p.net = this;
    }
    if (pin.net !== this) {
      throw 'Net.attach: expected the pin to have the correct net by now';
    }
  }

  isSink() {
    if (this.state === 'sink') {
      return true;
    } else if (this.state == 'source') {
      return false;
    } else if (this.state == 'floating') {
      return null;
    } else {
      throw 'Net.isSink: unknown state';
    }
  }

  isSource() {
    if (this.state === 'source') {
      return true;
    } else if (this.state == 'sink') {
      return false;
    } else if (this.state == 'floating') {
      return null;
    } else {
      throw 'Net.isSource: unknown state';
    }
  }

  // Update the state of this connection: source (high), sink (low), or
  // floating. It will call onupdate on all connected parts if the state
  // changed.
  update() {
    // Default state when no outputs are connected.
    let state = 'floating';

    for (let pin of this.pins) {
      // TODO: detect shorts
      if (pin.mode == 'output' && !pin.high) {
        state = 'sink';
        break
      }
      if (pin.mode == 'output' && pin.high) {
        state = 'source';
        break;
      }
    }

    if (state !== this.state) {
      // State was changed.
      this.state = state;

      // Notify all connected pins.
      for (let pin of this.pins) {
        if (pin.mode == 'input') {
          pin.part.onupdate(pin);
        }
      }
    }
  }
}

// An SPI master emulates a hardware SPI peripheral. It can send/receive one
// byte at a time.
class SPIMaster {
  constructor(part, number) {
    this.part = part;
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
    // Find connected SPI slaves.
    let recv = null;
    for (let pin of this.sck.net.pins) {
      if (pin.spiSlave === null) {
        continue;
      }
      let w = pin.spiSlave.transfer(this.sck, this.mosi, this.miso, send);
      if (typeof w === 'number') {
        if (recv !== null) {
          console.warn('SPIMaster.transfer: received byte from two slaves');
        }
        recv = w;
      }
    }

    if (recv === null) {
      // None of the connected devices (if any) returned anything.
      // We could theoretically also send a random value back, but we should
      // ideally warn at the same time. Unfortunately, we don't know whether
      // the returned byte is used at all.
      recv = 0;
    }
    return recv;
  }
}

// A SPI slave implements the slave part of a SPI bus. It is usually part of an
// external device, such as an MCU.
class SPISlave {
  constructor(sck, mosi, miso, callback) {
    this.sck = sck;
    this.mosi = mosi;
    this.miso = miso;
    this.callback = callback;

    // Set the SPI slave of the clock pin. This is the pin that will be checked
    // by the SPI master for connected SPI slaves.
    this.sck.setSPISlave(this);
  }

  // Transmit (send+receive) a single byte. It is called by the SPI master when
  // it needs to do a transmit.
  transfer(sck, mosi, miso, w) {
    if (this.sck.net !== sck.net) {
      throw 'SPISlave.transfer: wrong sck?';
    }
    if (!this.mosi || !mosi || this.mosi.net !== mosi.net) {
      // MOSI is not connected, so we didn't actually receive this byte.
      w = undefined;
    }
    w = this.callback(w);
    if (!this.miso || !miso || this.miso.net !== miso.net) {
      // MISO is not connected, so this byte is dropped on the floor instead of
      // being received by the SPI master.
      w = undefined;
    }
    return w;
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
        device = new LED(deviceConfig, deviceContent);
        if ('cathode' in deviceConfig) {
          device.cathode.attach(this.getPin(deviceConfig.cathode));
        }
        if ('anode' in deviceConfig) {
          device.anode.attach(this.getPin(deviceConfig.anode));
        }
      } else if (deviceConfig.type == 'rgbled') {
        device = new RGBLED(deviceConfig, deviceContent);
        if ('cathodes' in deviceConfig && deviceConfig.cathodes.length == 3) {
          device.red.attach(this.getPin(deviceConfig.cathodes[0]));
          device.green.attach(this.getPin(deviceConfig.cathodes[1]));
          device.blue.attach(this.getPin(deviceConfig.cathodes[2]));
        }
      } else if (deviceConfig.type == 'ws2812') {
        device = new WS2812(this, deviceConfig, deviceContent);
        device.din.attach(this.getPin(deviceConfig.din));
      } else if (deviceConfig.type == 'epd2in13') {
        device = new EPD2IN13(deviceConfig, deviceContent);
        device.sck.attach(this.getPin(deviceConfig.sck));
        device.mosi.attach(this.getPin(deviceConfig.mosi));
        device.cs.attach(this.getPin(deviceConfig.cs));
        device.dc.attach(this.getPin(deviceConfig.dc));
        device.rst.attach(this.getPin(deviceConfig.rst));
        device.busy.attach(this.getPin(deviceConfig.busy));
      } else if (deviceConfig.type == 'epd2in13x') {
        device = new EPD2IN13X(deviceConfig, deviceContent);
        device.sck.attach(this.getPin(deviceConfig.sck));
        device.mosi.attach(this.getPin(deviceConfig.mosi));
        device.cs.attach(this.getPin(deviceConfig.cs));
        device.dc.attach(this.getPin(deviceConfig.dc));
        device.rst.attach(this.getPin(deviceConfig.rst));
        device.busy.attach(this.getPin(deviceConfig.busy));
      } else if (deviceConfig.type == 'st7789') {
        device = new ST7789(deviceConfig, deviceContent);
        device.sck.attach(this.getPin(deviceConfig.sck));
        device.mosi.attach(this.getPin(deviceConfig.mosi));
        device.cs.attach(this.getPin(deviceConfig.cs));
        device.dc.attach(this.getPin(deviceConfig.dc));
        device.reset.attach(this.getPin(deviceConfig.reset));
      } else {
        console.warn('unknown device type:', deviceConfig);
        continue;
      }
    }
  }

  // Return the configured (human-readable) name.
  get name() {
    return this.config.name;
  }

  onupdate() {
    // Nothing changes on pin changes.
    // TODO: interrupts.
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
      this.spiBuses[number] = new SPIMaster(this, number);
    }
    return this.spiBuses[number];
  }
}

// getProjects returns the complete list of project objects from the projects
// store. It returns an empty list when the database hasn't been initialized
// yet.
async function getProjects() {
  // Load all projects.
  if (!db) {
    return [];
  }
  let projects = [];
  return await new Promise(function(resolve, reject) {
    db.transaction(['projects'], 'readonly').objectStore('projects').openCursor().onsuccess = function(e) {
      var cursor = e.target.result;
      if (cursor) {
        projects.push(cursor.value);
        cursor.continue();
      } else {
        resolve(projects);
      }
    }
  });
}

// updateBoards updates the dropdown menu. This must be done after loading the
// boards or updating the target selection.
async function updateBoards() {
  if (project) {
    let button = document.querySelector('#target > button');
    if (project.created) {
      if (project.projectHumanName) {
        button.textContent = project.projectHumanName + ' ';
      } else {
        button.textContent = project.config.humanName + ' * ';
      }
    } else {
      button.textContent = project.config.humanName + ' ';
    }
  }

  let projects = await getProjects();

  let dropdown = document.querySelector('#target > .dropdown-menu');
  dropdown.innerHTML = '';
  for (let name in boards) {
    let board = boards[name];
    let item = document.createElement('a');
    item.textContent = board.humanName;
    item.classList.add('dropdown-item');
    if (project && name == project.name) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = name;
    dropdown.appendChild(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      let boardConfig = boards[item.dataset.name];
      setProject(boardConfig.name);
    });
  }

  if (!projects.length) {
    // No saved projects.
    return;
  }

  let divider = document.createElement('div');
  divider.classList.add('dropdown-divider');
  dropdown.appendChild(divider);

  // Add a list of projects (modified templates).
  for (let projectObj of projects) {
    let board = boards[projectObj.target];
    let item = document.createElement('a');
    item.innerHTML = '<span class="text"><span class="name"></span> – <i class="time"></i></span><span class="buttons"><button class="btn btn-light btn-sm edit-symbol rename" title="Rename">✎</button> <button class="btn btn-light btn-sm delete" title="Delete">🗑</button></span>';
    if (projectObj.humanName) {
      item.querySelector('.text').textContent = projectObj.humanName;
    } else {
      item.querySelector('.name').textContent = board.humanName;
      item.querySelector('.time').textContent = projectObj.created.toISOString();
    }
    item.classList.add('dropdown-item');
    item.classList.add('project-name');
    if (project && projectObj.name == project.name) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = projectObj.name;
    dropdown.appendChild(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      setProject(item.dataset.name);
    });

    item.querySelector('.rename').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      let name = e.target.parentNode.parentNode.dataset.name;
      let humanName = prompt('Project name');

      if (project.name == name) {
        // Update name of current project.
        project.projectHumanName = humanName;
      }
      let tx = db.transaction(['projects'], 'readwrite');
      tx.objectStore('projects').get(name).onsuccess = function(e) {
        let obj = e.target.result;
        obj.humanName = humanName;
        tx.objectStore('projects').put(obj).onsuccess = function(e) {
          updateBoards();
        };
      };
    });

    item.querySelector('.delete').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      let name = e.target.parentNode.parentNode.dataset.name;
      if (name == project.name) {
        setProject(project.target);
      }
      db.transaction(['projects'], 'readwrite').objectStore('projects').delete(name);
      updateBoards();
    });
  }
}

function loadBoards() {
  fetch('boards.json').then((response) => {
    response.json().then((data) => {
      Object.assign(boards, data);
      updateBoards();
    });
  }).catch((reason) => {
    // TODO
    console.error(reason);
  });
}
