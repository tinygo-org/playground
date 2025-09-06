'use strict';

// A pin is one pin of a part. It can be in various states (floating, low,
// high) and it's possible to sample the current state (low, high) from it.
class Pin {
  constructor(id, part, state) {
    this.id = id;
    this.part = part;
    this.state = state ? state : 'floating';
    this.net = null;
    this.mode = 'gpio';
    this.pwmPeriod = 0;
    this.pwmDutyCycle = 0;
  }

  // notifyPart sends a pin update notification to the attached part.
  notifyPart() {
    this.part.notifyPinUpdate(this);
  }

  // setState sets the output state of the pin: as low, high, or floating.
  setState(state, mode) {
    mode = mode ? mode : 'gpio';
    if (this.state === state && this.mode === mode)
      return;
    this.mode = mode ? mode : 'gpio';
    this.state = state;
    if (this.net) {
      // setState() might be called while setting up parts, and thus before
      // nets are updated for the first time.
      this.net.updateState();
    }
  }

  // Set the pin state to high or low. It should already be configured as an
  // output pin.
  set(high) {
    let state = high ? 'high' : 'low';
    if (!this.isOutput()) {
      console.warn('pin ' + this.id + ' got set to ' + state + ' while it is configured as ' + this.state);
      return;
    }
    this.setState(state);
  }

  // get() returns the state as read by a Pin.Get() call from Go. It will log a
  // warning when reading from a floating pin.
  get() {
    let state = this.net.state;
    if (state === 'high') {
      return true;
    } else if (state === 'low') {
      return false;
    } else if (state === 'floating') {
      console.warn('reading from floating pin ' + this.id);
      // Return a random value, to simulate a floating input.
      // (This is not exactly accurate, but perhaps more accurate than
      // returning a fixed 'high' or 'low').
      return Math.random() < 0.5;
    } else if (state === 'pullup') {
      return true;
    } else if (state === 'pulldown') {
      return false;
    } else {
      console.warn('unknown state: ' + state);
      return false;
    }
  }

  // getNumeric gets a pin state as a numeric value. It doesn't warn for a floating pin.
  getNumeric() {
    let state = this.net.state;
    if (state === 'floating') {
      return 0;
    } else if (state === 'low') {
      return 1;
    } else if (state === 'high') {
      return 2;
    } else if (state === 'pulldown') {
      return 3;
    } else if (state === 'pullup') {
      return 4;
    } else if (state === 'pwm') {
      return 5;
    } else {
      console.error('unknown state: ' + state);
      return 0;
    }
  }

  // returns whether this is an output pin, that is, low or high.
  // A pull-up or pull-down doesn't count as an output.
  isOutput() {
    return this.state === 'low' || this.state === 'high';
  }

  // returns whether this is an input pin (which may be a pullup, pulldown, or
  // floating).
  isInput() {
    return !this.isOutput();
  }

  // isConnected returns whether there are any other devices connected to this
  // pin - floating or not. This is used for LEDs.
  isConnected() {
    return this.net.pins.size > 1;
  }

  // Set the period and duty cycle of this pin. This is called from the PWM
  // peripheral.
  setPWM(period, dutyCycle) {
    if (this.state !== 'pwm')
      return;
    this.pwmPeriod = period;
    this.pwmDutyCycle = dutyCycle;
    if (this.net) {
      this.net.updateState();
    }
  }

  // writeWS2812 writes a WS2812 buffer to the net.
  writeWS2812(buf) {
    if (!this.isOutput()) {
      // Writing is only possible when this pin is set as an output.
      return;
    }
    for (let pin of this.net.pins) {
      if (pin.mode !== 'ws2812-din' || pin.state !== 'floating')
        continue;
      pin.part.writeWS2812(buf);
    }
  }
}

// Base class for all electronic parts.
class Part {
  constructor(schematic, config) {
    this.schematic = schematic;
    this.id = config.id;
    this.type = config.type;
    this.pins = {};
    this.spiBuses = {};
    this.i2cBuses = {};
    this.pwmInstances = {};
    this.properties = null;
    this.hasUpdate = false;
    this.powerState = new PowerTracker(this);
  }

  // getPin returns a pin by ID. It can be either a pin name (such as PB5) or a
  // pin number (such as 5).
  getPin(id) {
    let pin = this.pins[id];
    if (!pin) {
      console.error('pin:', id);
      throw 'unknown pin';
    }
    return pin;
  }

  // getSPI returns a SPI bus by bus number, or creates one if the bus doesn't
  // exist yet. This bus is initially unconfigured.
  getSPI(bus) {
    let instance = this.spiBuses[bus];
    if (!instance) {
      instance = new SPIBus();
      this.spiBuses[bus] = instance;
    }
    return instance;
  }

  // getI2C returns an I2C bus by bus number, or creates one if the bus doesn't
  // exist yet. The bus is initially unconfigured.
  getI2C(bus) {
    let instance = this.i2cBuses[bus];
    if (!instance) {
      instance = new I2CBus();
      this.i2cBuses[bus] = instance;
    }
    return instance;
  }

  // getPWM returns the given PWM instance number, and creates it if it doesn't
  // exist yet.
  getPWM(number) {
    let instance = this.pwmInstances[number];
    if (!instance) {
      instance = new PWMInstance();
      this.pwmInstances[number] = instance;
    }
    return instance;
  }

  // Notify that one of the pins of this part has changed in state.
  // This can be overridden in subclasses, the default action is to do nothing.
  notifyPinUpdate() {
  }

  // notifyUpdate marks this part as having an update to be sent to the UI.
  notifyUpdate() {
    if (this.hasUpdate)
      return; // already notified
    this.hasUpdate = true;
    this.schematic.notifyUpdate();
  }

  // getState sends the current state to the UI.
  // It's a stub, subclasses should properly implement it.
  getState() {
    console.warn('unimplemented: getState for', this.type);
    return {
      id: this.id,
    };
  }

  // handleInput is called when an input event is received from the UI.
  handleInput() {
    console.warn('unimplemented: handleInput for', this.type);
  }

  // Return the parent ID (everything before the last dot), or '' if there is no
  // parent.
  parentId() {
    let pos = this.id.lastIndexOf('.');
    if (pos < 0) return '';
    return this.id.substring(0, pos);
  }
}

// Track power of a part.
class PowerTracker {
  constructor(part) {
    this.part = part;
    this.current = NaN;
    this.maxCurrent = NaN;
    this.coulombs = 0;
  }

  update(current) {
    if (current === this.current || (isNaN(current) && isNaN(this.current))) {
      // Nothing changed, so don't update anything.
      return;
    }
    if (isNaN(current)) {
      throw 'current must not be NaN';
    }
    if (isNaN(this.current)) {
      // First update.
      this.current = current;
      this.maxCurrent = current;
      let now = performance.now() / 1000;
      this.start = now;
      this.lastUpdate = now;
    } else {
      this.part.schematic.updatePowerContinuously(this.part);
      let now = performance.now() / 1000;
      let timeSinceUpdate = now - this.lastUpdate;
      let coulombs = timeSinceUpdate * this.current; // coulombs since the previous update
      this.coulombs += coulombs;
      this.current = current;
      this.lastUpdate = now;
      if (current > this.maxCurrent) {
        this.maxCurrent = current;
      }
    }
  }

  getState() {
    let now = performance.now() / 1000;
    let timeSinceUpdate = now - this.lastUpdate;
    let timeSinceStart = now - this.start;
    let coulombs = this.coulombs + timeSinceUpdate * this.current;
    let state = {
      current: this.current,
      maxCurrent: this.maxCurrent,
      avgCurrent: coulombs / timeSinceStart,
    };
    return state;
  }
}

// Board implements a generic board with subparts on it. This is needed to
// provide pins to attach wires to: the UI allows creating new wires between
// pins on a board.
class Board extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    for (let name of config.pins) {
      this.pins[name] = new Pin(config.id + '.' + name, this);
    }
    // Standard VCC/GND pin for completeness (most development boards have some
    // 3.3V/GND pins for example).
    this.pins['vcc'] = new Pin(config.id + '.vcc', this, 'high');
    this.pins['gnd'] = new Pin(config.id + '.gnd', this, 'low');
    this.power = {
      id: this.id,
      humanName: config.humanName,
    }
  }

  getState() {
    return {
      id: this.id,
    };
  }
}

// Dummy is a dummy part, that can for example be used to insert a dummy power
// consumption on a board as a catch-all baseload.
class Dummy extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    if (config.current) {
      this.power = {
        id: this.id,
        humanName: config.humanName,
        source: this.parentId(),
      }
      this.powerState.update(config.current);
      this.notifyUpdate();
    }
  }

  getState() {
    return {
      id: this.id,
      power: this.powerState.getState(),
    };
  }
}

// MCU implements a MCU like part, that runs a program, logs to stdout, and
// usually has lots of GPIO pins.
class MCU extends Part {
  bufferMutexIndex = 0;
  bufferSpeedIndex = 1;
  bufferPinIndex = 2;
  bufferI2CBusStatusIndex = this.bufferPinIndex + 256;

  constructor(schematic, config) {
    super(schematic, config);
    this.pins[255] = new Pin(config.id + '.NoPin', this);
    for (let [name, number] of Object.entries(config.pins)) {
      let pin = new Pin(config.id + '.' + name, this);
      pin.number = number;
      this.pins[name] = pin;
      this.pins[number] = pin;
    }
  }

  notifyPinUpdate(pin) {
    // Update SharedArrayBuffer that is shared with the runner.
    // But only do this after initialization (all pins are also set to their
    // default state on initialization).
    if (this.workerBuffer !== undefined) {
      let state = pin.getNumeric();
      let number = pin.number;
      Atomics.store(this.workerBuffer, this.bufferPinIndex+number, state);
    }
  }

  getState() {
    return {
      id: this.id,
    };
  }

  // Start running the code in a separate web worker.
  async start(sourceData, runnerURL) {
    if (!crossOriginIsolated) {
      // Probably running inside VSCode.
      // Don't start a separate runner (because we have no SharedArrayBuffer),
      // run the runner directly here.
      startRunner(sourceData, msg => this.#handleRunnerMessage(msg));
    } else {
      let runner = new Worker(runnerURL);
      runner.postMessage({
        type: 'start',
        sourceData: sourceData,
      })
      runner.onmessage = (e) => this.#handleRunnerMessage(e.data);
    }
  }

  // Process message coming from the runner.
  async #handleRunnerMessage(msg) {
    if (msg.type === 'started') {
      postMessage({type: 'started'});
      // SharedArrayBuffer shared with the runner. The format is described in
      // the runner.
      this.workerBuffer = new Int32Array(msg.dataBuffer);
      // Update pin states.
      for (let i=0; i<255; i++) {
        let pin = this.pins[i];
        if (pin !== undefined) {
          let state = pin.getNumeric();
          Atomics.store(this.workerBuffer, this.bufferPinIndex+i, state);
        }
      }
    } else if (msg.type === 'pin-configure') {
      this.getPin(msg.pin).setState(msg.state);
      this.#finishedTask();
    } else if (msg.type === 'gpio-set') {
      this.getPin(msg.pin).set(msg.high);
      this.#finishedTask();
    } else if (msg.type === 'pwm-configure') {
      let instance = this.getPWM(msg.instance);
      instance.configure(msg.instance, msg.frequency, msg.top);
    } else if (msg.type === 'pwm-channel-configure') {
      let instance = this.getPWM(msg.instance);
      instance.channelConfigure(msg.channel, this.getPin(msg.pin));
    } else if (msg.type === 'pwm-channel-set') {
      let instance = this.getPWM(msg.instance);
      instance.channelSet(msg.channel, msg.value);
    } else if (msg.type === 'i2c-configure') {
      let bus = this.getI2C(msg.bus);
      bus.configureAsController(this.getPin(msg.scl), this.getPin(msg.sda));
    } else if (msg.type === 'i2c-transfer') {
      let bus = this.getI2C(msg.bus);
      let errCode = bus.transfer(msg.address, msg.w, msg.r);
      Atomics.store(this.workerBuffer, this.bufferI2CBusStatusIndex + msg.bus, errCode);
      this.#finishedTask();
    } else if (msg.type === 'spi-configure') {
      let bus = this.getSPI(msg.bus);
      bus.configureAsController(this.getPin(msg.sck), this.getPin(msg.sdo), this.getPin(msg.sdi));
    } else if (msg.type === 'spi-transfer') {
      let bus = this.getSPI(msg.bus);
      for (let b of msg.data) {
        bus.transfer(b);
      }
      this.#finishedTask();
    } else if (msg.type === 'ws2812-write') {
      this.getPin(msg.pin).writeWS2812(msg.data);
    } else if (msg.type === 'compiling' || msg.type === 'loading' || msg.type === 'exited' || msg.type === 'error' || msg.type === 'stdout') {
      // Just forward the message to the UI.
      postMessage(msg);
    } else {
      console.warn('unknown message from runner:', msg);
    }
  }

  // Mark a task (incoming message) as processed.
  #finishedTask() {
    // Subtract one from the task counter.
    let oldValue = Atomics.sub(this.workerBuffer, this.bufferMutexIndex, 1);
    let newValue = oldValue - 1;
    if (newValue === 0) {
      // Notify the runner that all messages are handled. The runner will wait
      // for this when reading from a GPIO pin to make sure it doesn't read an
      // old value.
      Atomics.notify(this.workerBuffer, this.bufferMutexIndex);
    }
  }

  // Pause or resume the execution of the MCU.
  // It works somewhat like a debugger that pauses execution.
  playpause() {
    let running = Atomics.load(this.workerBuffer, this.bufferSpeedIndex) !== 0;
    running = !running;
    let speed = running ? 1 : 0;
    Atomics.store(this.workerBuffer, this.bufferSpeedIndex, speed);
    Atomics.notify(this.workerBuffer, this.bufferSpeedIndex);
    return speed;
  }
}

// Button implements a typical push button (single pole, normally open).
class Button extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins.A = new Pin(config.id + '.A', this);
    this.pins.B = new Pin(config.id + '.B', this);
    this.pins.A.connected = this.pins.B;
    this.pins.B.connected = this.pins.A;
    this.properties = {
      humanName: config.humanName,
      id: this.id,
      type: 'text',
    };
    this.pressed = false;
    this.notifyUpdate();
  }

  getState() {
    return {
      id: this.id,
      properties: this.pressed ? 'pressed' : 'released',
      cssProperties: {
        pressed: this.pressed ? '1' : '0',
      },
    };
  }

  handleInput(data) {
    let pressed = data.event === 'press';
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    if (pressed) {
      this.pins.A.state = 'connected';
      this.pins.B.state = 'connected';
      this.pins.A.net.updateState();
    } else {
      this.pins.A.state = 'floating';
      this.pins.B.state = 'floating';
      this.pins.A.net.updateState();
      this.pins.B.net.updateState();
    }
    this.notifyUpdate();
  }
}

// LED is a regular monochromatic LED with two pins.
// This implementation has the special property that if a wire is not
// connected, it shows as "on". That's to simplify wiring of them.
class LED extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.color = config.color;
    this.current = config.current;
    this.pins.anode = new Pin(config.id + '.anode', this);
    this.pins.cathode = new Pin(config.id + '.cathode', this);
    this.properties = {
      humanName: config.humanName,
      id: this.id,
      type: 'text',
    };
    this.power = {
      humanName: config.humanName,
      id: this.id,
      source: this.parentId(),
    }
    this.on = null;
    this.pwmPeriod = 0;
    this.pwmDutyCycle = 0;
  }

  notifyPinUpdate() {
    // The LED input pins were changed, so the state _probably_ changed.
    this.updateState();
  }

  updateState() {
    let anodeConnected = this.pins.anode.isConnected();
    let cathodeConnected = this.pins.cathode.isConnected();
    let anode = anodeConnected ? this.pins.anode.net.isSource() : true;
    let cathode = cathodeConnected ? this.pins.cathode.net.isSink() : true;
    let on = (anode && cathode && (anodeConnected || cathodeConnected)) ? 1 : 0;
    let period = 0;
    let dutyCycle = 0;
    if (anode && this.pins.cathode.net.state === 'pwm') {
      // Cathode is connected to PWM output.
      period = this.pins.cathode.net.extra.period;
      dutyCycle = this.pins.cathode.net.extra.dutyCycle;
    } else if (cathode && this.pins.anode.net.state === 'pwm') {
      // Anode is connected to PWM output.
      // TODO: invert duty cycle (first part high and later part 0) instead of
      // just inverting the duty cycle value.
      period = this.pins.anode.net.extra.period;
      dutyCycle = 1-this.pins.anode.net.extra.dutyCycle;
    }

    if (period !== 0) {
      // PWM
      if (period > 1000/30) {
        // Longer period, use animation.
        this.pwmPeriod = period;
        this.pwmDutyCycle = dutyCycle;
        this.on = 1;
      } else {
        // Shorter period, fade the LED.
        this.pwmPeriod = 0;
        this.on = dutyCycle;
      }
      // TODO: change power state together with the blinking?
      this.powerState.update(this.current * dutyCycle);
      this.notifyUpdate();
    } else if (on !== this.on) {
      this.pwmPeriod = 0;
      this.on = on;
      this.powerState.update(this.current * on);
      this.notifyUpdate();
    }
  }

  getState() {
    let [r, g, b] = this.color;
    r = encodeSRGB(r * this.on / 255);
    g = encodeSRGB(g * this.on / 255);
    b = encodeSRGB(b * this.on / 255);
    let state = {
      id: this.id,
      cssProperties: colorProperties([r, g, b]),
      properties: this.on ? 'on' : 'off',
      power: this.powerState.getState(),
    };
    if (this.pwmPeriod) {
      state.cssBlink = {
        period: this.pwmPeriod,
        dutyCycle: this.pwmDutyCycle,
        cssPropertiesOff: colorProperties([0, 0, 0]),
      };
    }
    return state;
  }
}

// RGBLED is a typical common anode RGB LED, meaning that it has four wires of
// which one is connected to VCC and the other three can be set to low to turn
// them on.
class RGBLED extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins.r = new Pin(config.id + '.r', this);
    this.pins.g = new Pin(config.id + '.g', this);
    this.pins.b = new Pin(config.id + '.b', this);
    this.channelCurrent = config.channelCurrent || [NaN, NaN, NaN];
    this.properties = {
      humanName: config.humanName,
      id: this.id,
      type: 'text',
    };
    this.power = {
      humanName: config.humanName,
      id: this.id,
      source: this.parentId(),
    };
  }

  notifyPinUpdate() {
    // The LED input pins were changed, so the state _probably_ changed.
    this.updateState();
  }

  updateState() {
    let r = this.pins.r.net.isSink() ? 255 : 0;
    let g = this.pins.g.net.isSink() ? 255 : 0;
    let b = this.pins.b.net.isSink() ? 255 : 0;
    if (r !== this.r || g !== this.g || b !== this.b) {
      this.r = r;
      this.g = g;
      this.b = b;
      this.powerState.update(r/255*this.channelCurrent[0] + g/255*this.channelCurrent[1] + b/255*this.channelCurrent[2]);
      this.notifyUpdate();
    }
  }

  getState() {
    let colorName = {
      '': 'off',
      'r': 'red',
      'g': 'green',
      'b': 'blue',
      'rg': 'yellow',
      'gb': 'aqua',
      'rb': 'fuchsia',
      'rgb': 'white',
    }[(this.r ? 'r' : '') + (this.g ? 'g' : '') + (this.b ? 'b' : '')];
    return {
      id: this.id,
      cssProperties: colorProperties([this.r, this.g, this.b]),
      properties: colorName,
      power: this.powerState.getState(),
    };
  }
}

// E-paper display by WaveShare.
// https://www.waveshare.com/w/upload/e/e6/2.13inch_e-Paper_Datasheet.pdf
class EPD2IN13 extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.width = config.width;
    this.height = config.height;
    this.pins.sck = new Pin(config.id + '.sck', this);
    this.pins.sdi = new Pin(config.id + '.sdi', this);
    this.pins.cs = new Pin(config.id + '.cs', this);
    this.pins.dc = new Pin(config.id + '.dc', this);
    this.pins.rst = new Pin(config.id + '.rst', this);
    this.pins.busy = new Pin(config.id + '.busy', this, 'low');
    this.bus = new SPIBus();
    this.bus.configureAsPeripheral(this.pins.sck, null, this.pins.sdi);

    // Initialize buffer to 0xff (white).
    this.buffer = new Uint8Array(this.bufferWidth * Math.ceil(this.height / 8));
    for (let i=0; i<this.buffer.length; i++) {
      this.buffer[i] = 255;
    }
    this.command = null; // last command that was issued
    this.dataBuf = []; // bytes since last command
    this.addressX = 0;
    this.addressY = 0;
  }

  // The buffer width is a bit bigger than the real display width.
  get bufferWidth() {
    return Math.ceil(this.width / 8) * 8;
  }

  transferSPI(sck, w) {
    if (!this.pins.cs.net.isLow()) {
      return;
    }
    if (this.pins.dc.net.isHigh()) {
      // data
      if (this.dataBuf !== null) {
        this.dataBuf.push(w);
      }
      if (this.command === 0x24) {
        // Write RAM
        this.buffer[this.addressX + this.addressY * Math.ceil(this.bufferWidth/8)] = w;
        this.addressX++;
      } else if (this.command === 0x44) {
        // Specify the start/end positions of the window address in the Y
        // direction by an address unit
      } else if (this.command === 0x4e) {
        // Set RAM X address counter.
        this.addressX = decodeLittleEndian(this.dataBuf);
      } else if (this.command === 0x4f) {
        // Set RAM Y address counter.
        this.addressY = decodeLittleEndian(this.dataBuf);
      }
    } else {
      // command
      this.command = w;
      if (this.command === 0x20) {
        // Activate display update sequence.
        this.notifyUpdate();
      } else if (this.command === 0x24) {
        // Do not buffer the "Write RAM" command.
      } else {
        this.dataBuf = [];
      }
    }
    return 0;
  }

  getState() {
    // Create a new image buffer to be drawn in the UI.
    let imageData = new Uint8ClampedArray(this.width * this.height * 4);
    for (let x=0; x<this.width; x++) {
      for (let y=0; y<this.height; y++) {
        let byteIndex = Math.floor((x + y*this.bufferWidth) / 8);
        let whiteSet = this.buffer[byteIndex] & (0x80 >> x%8);
        let index = 4 * (y*this.width + x);
        if (whiteSet) {
          imageData[index+0] = 255; // R
          imageData[index+1] = 255; // G
          imageData[index+2] = 255; // B
        } else {
          imageData[index+0] = 0; // R
          imageData[index+1] = 0; // G
          imageData[index+2] = 0; // B
        }
        imageData[index+3] = 255; // A
      }
    }

    // Send the resulting image.
    return {
      id: this.id,
      canvas: imageData,
    };
  }
}

// ST7789 is a display controller for LCD screens up to 240x320 pixels.
// Datasheet:
// https://www.newhavendisplay.com/appnotes/datasheets/LCDs/ST7789V.pdf
class ST7789 extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.width = config.width;
    this.height = config.height;
    this.pins.sck = new Pin(config.id + '.sck', this);
    this.pins.sdi = new Pin(config.id + '.sdi', this);
    this.pins.cs = new Pin(config.id + '.cs', this);
    this.pins.dc = new Pin(config.id + '.dc', this);
    this.pins.reset = new Pin(config.id + '.reset', this);
    this.spi = new SPIBus();
    this.spi.configureAsPeripheral(this.pins.sck, null, this.pins.sdi);

    this.imageData = new Uint8ClampedArray(this.width * this.height * 4);
    this.inReset = false;
    this.command = 0x00; // nop
    this.dataBuf = null;
    this.softwareReset();

    this.power = {
      id: this.id,
      humanName: config.humanName,
      source: this.parentId(),
    };

    this.current = NaN;
    this.updateState();
  }

  notifyPinUpdate(pin) {
    if (this.pins.reset.net.isLow() != this.inReset) {
      this.inReset = this.pins.reset.net.isLow();
      if (this.inReset) {
        this.softwareReset();
        this.updateState();
        this.notifyUpdate();
      }
    }
  }

  // Reset all registers to their default state.
  softwareReset() {
    this.xs = 0;
    this.xe = 0xef; // note: depends on MV value
    this.ys = 0;
    this.ye = 0x13f; // note: depends on MV value
    this.inverse = false; // display inversion off
    this.madctl = 0 // not sure what the default is
    this.sleeping = true;

    // Give these a sensible default value. Will be updated with the RAMWR
    // command.
    this.x = 0;
    this.y = 0;
    this.dataByte = null;
  }

  // Handle an incoming SPI byte.
  transferSPI(sck, w) {
    if (this.pins.cs.isConnected() && !this.pins.cs.net.isLow()) {
      return;
    }
    if (this.pins.dc.net.isHigh()) {
      // data
      if (this.dataBuf !== null) {
        this.dataBuf.push(w);
      }
      if (this.command == 0x2a && this.dataBuf.length == 4) {
        // CASET: column address set
        this.xs = (this.dataBuf[0] << 8) + this.dataBuf[1];
        this.xe = (this.dataBuf[2] << 8) + this.dataBuf[3];
        if (this.xs > this.xe) {
          console.warn('st7789: xs must be smaller than or equal to xe');
        }
      } else if (this.command == 0x2b && this.dataBuf.length == 4) {
        // RASET: row address set
        this.ys = (this.dataBuf[0] << 8) + this.dataBuf[1];
        this.ye = (this.dataBuf[2] << 8) + this.dataBuf[3];
        if (this.ys > this.ye) {
          console.warn('st7789: ys must be smaller than or equal to ye');
        }
      } else if (this.command == 0x2c) {
        // RAMWR: memory write
        if (this.dataByte === null) {
          // First byte received. Record this byte for later use.
          this.dataByte = w;
        } else {
          // Second byte received.
          let word = (this.dataByte << 8) + w;
          this.dataByte = null;

          // Determine RAM location of the pixel.
          let x = this.x;
          let y = this.y;
          if (this.madctl & (1<<5)) { // MV
            [x, y] = [y, x];
          }
          if (this.madctl & (1<<6)) { // MX
            x = 239 - x;
          }
          if (this.madctl & (1<<7)) { // MY
            y = 319 - y;
          }

          // Draw the pixel.
          if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
            // TODO: just write to a memory buffer and only create the image
            // data in this.getState.
            let red = Math.round((word >> 11) * 255 / 31);
            let green = Math.round(((word >> 5) & 63) * 255 / 63);
            let blue = Math.round((word & 31) * 255 / 31);
            let index = 4 * (y*this.width + x);
            this.imageData[index+0] = red;
            this.imageData[index+1] = green;
            this.imageData[index+2] = blue;
            this.imageData[index+3] = 0xff; // alpha channel
            this.notifyUpdate();
          }

          // Increment row/column address.
          this.x += 1;
          if (this.x > this.xe) {
            this.x = this.xs;
            this.y += 1;
          }
          if (this.y > this.ye) {
            this.y = this.ys;
          }
        }
      } else if (this.command == 0x36 && this.dataBuf.length == 1) {
        // MADCTL: memory data access control
        // Controls how the display is updated, and allows rotating it.
        this.madctl = this.dataBuf[0];
      } else if (this.command == 0x3a && this.dataBuf.length == 1) {
        // COLMOD: color format
        if (this.dataBuf[0] != 0x55) {
          // Only the 16-bit interface is currently supported.
          console.warn('st7789: unknown COLMOD value:', this.dataBuf[0]);
        }
      }
    } else {
      this.command = w;
      this.dataBuf = null;
      if (w == 0x01) {
        // SWRESET: re-initialize all registers
        this.softwareReset();
      } else if (w == 0x11) {
        // SLPOUT: update sleep state
        this.sleeping = false;
        this.updateState();
      } else if (w == 0x13) {
        // NORON: normal display mode on
        // Sets the display to normal mode (as opposed to partial mode).
        // Defaults to on, so nothing to do here.
      } else if (w == 0x20) {
        // INVOFF: display inversion off
        this.inverse = false;
      } else if (w == 0x21) {
        // INVON: display inversion on
        this.inverse = true;
      } else if (w == 0x29) {
        // DISPON: display on
        // The default is to disable the display, this command enables it.
        // Ignore it, it's not super important in simulation (but should
        // eventually be implemented by blanking the display when off).
      } else if (w == 0x2a || w == 0x2b) {
        // CASET: column address set
        // RASET: row address set
        this.dataBuf = [];
      } else if (w == 0x2c) {
        // RAMWR: memory write
        this.x = this.xs;
        this.y = this.ys;
        this.dataByte = null;
      } else if (w == 0x3a) {
        // COLMOD: interface pixel format
        this.dataBuf = [];
      } else if (w == 0x36) {
        // MADCTL: memory data access control
        // It can be used to rotate/swap the display (see 8.12 Address Control
        // in the PDF), but has not yet been implemented.
        this.dataBuf = [];
      } else if (w === 0xb2) {
        // PORCTRL: porch setting
        // Can probably be ignored.
      } else if (w === 0xc6) {
        // FRCTRL2: frame rate control
        // Can definitely be ignored, since we use the system's frame rate.
      } else {
        // unknown command
        console.log('st7789: unknown command:', w);
      }
    }
    return 0;
  }

  updateState() {
    let current = this.sleeping ? 0.000020 : 0.006; // values come from the datasheet
    if (current !== this.current) {
      this.powerState.update(current);
      this.notifyUpdate();
    }
  }

  getState() {
    // Send the image data.
    return {
      id: this.id,
      canvas: this.imageData,
      power: this.powerState.getState(),
    };
  }
}

// Emulate a typical WS2812 LED strip that uses the GRB color order.
class WS2812 extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins.din = new Pin(config.id + '.din', this);
    this.pins.dout = new Pin(config.id + '.dout', this, 'low');
    this.pins.din.mode = 'ws2812-din';
    this.length = config.length;
    this.channelCurrent = config.channelCurrent || [0.011, 0.011, 0.011]; // measured values
    this.data = new Uint8Array(this.length * 3);
    this.properties = {
      humanName: config.humanName,
      id: this.id,
      type: 'ledstrip',
      colors: [
        {
          title: 'red',
          color: 'red',
        },
        {
          title: 'green',
          color: 'green',
        },
        {
          title: 'blue',
          color: 'blue',
        },
      ],
      length: this.length,
    };
    this.power = {
      humanName: config.humanName,
      id: this.id,
      source: this.parentId(),
    }
    this.updateState();
  }

  writeWS2812(buf) {
    if (buf.length <= this.data.length) {
      this.data.set(buf);
    } else {
      this.data.set(buf.subarray(0, this.data.length));
      this.pins.dout.writeWS2812(buf.subarray(this.data.length));
    }
    this.updateState();
  }

  updateState() {
    if (!this.updateTimeout) {
      this.updateTimeout = setTimeout(() => {
        this.updateTimeout = 0;
        this.updateStateNow();
        this.notifyUpdate();
      }, 0);
    }
  }

  updateStateNow() {
    // Calculate the buffer of RGB values to send to the UI.
    this.colorProperties = [];
    this.propertyData = [];
    let current = this.length * 0.0006; // quiescent current (measured 0.6mA)
    for (let i=0; i < this.length; i++) {
      // Extract data from the array. Note that the data is in GRB order, at
      // least on most chips. TODO: make this configurable.
      // The data is in reverse order, so in this case the order is BRG instead
      // of GRB.
      let r = this.data[i*3+1];
      let g = this.data[i*3+2];
      let b = this.data[i*3+0];
      this.propertyData.push([r, g, b]);

      // Current consumed by the LEDs.
      current += r/255*this.channelCurrent[0] + g/255*this.channelCurrent[1] + b/255*this.channelCurrent[2];

      // Do a gamma correction. The LEDs are in linear color space, while the
      // web uses the sRGB color space (with gamma=~2.2).
      // Without any gamma correction, the LEDs would look way too dark.
      r = encodeSRGB(r / 255);
      g = encodeSRGB(g / 255);
      b = encodeSRGB(b / 255);

      this.colorProperties.push(colorProperties([r, g, b]));
    }

    this.powerState.update(current);
  }

  getState() {
    // Send the resulting data.
    return {
      id: this.id,
      ledstrip: this.colorProperties,
      properties: this.propertyData,
      power: this.powerState.getState(),
    };
  }
}

// Simulate a servo, as commonly used in hobby R/C cars for example.
class Servo extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins.control = new Pin(config.id + '.control', this);
    this.properties = {
      humanName: config.humanName,
      id: this.id,
      type: 'text',
    };
    this.power = {
      humanName: config.humanName,
      id: this.id,
      source: this.parentId(),
    }
    this.speed = 600; // degrees turned per second
    this.idleCurrent = 0.006;  // ~6mA
    this.stallCurrent = 0.800; // ~800mA
    this.fullRotation = 180;   // 180° servo
    this.rotation = 0;
    this.rotationTime = 0;
    this.rotationTarget = 0;
    this.powerState.update(this.idleCurrent)
    this.updateState();
  }

  notifyPinUpdate() {
    this.updateState();
  }

  updateState() {
    let pin = this.pins.control;
    if (pin.net && pin.net.state === 'pwm') {
      let timeOn = pin.net.extra.period * pin.net.extra.dutyCycle;
      // Accept the following:
      //   - period size between 3ms and 100ms
      //   - pulse width between 800µs and 2200µs
      if (pin.net.extra.period > 3 && pin.net.extra.period < 100) {
        if (timeOn < 0.8)
          timeOn = 0.8;
        if (timeOn > 2.2) {
          timeOn = 2.2;
        }
        let rotationTarget = (1.5 - timeOn) * this.fullRotation;
        if (this.rotation !== rotationTarget) {
          this.rotationTarget = rotationTarget;
          this.rotationTime = performance.now();
          this.notifyUpdate();
        }
      }
    }
  }

  #updateRotation() {
    let now = performance.now();
    if (this.rotation !== this.rotationTarget) {
      this.powerState.update(this.stallCurrent)
      let elapsed = now - this.rotationTime;
      if (this.rotationTarget > this.rotation) {
        // Rotating clockwise.
        let newRotation = this.rotation + this.speed*elapsed/1000;
        if (newRotation > this.rotationTarget) {
          // Reached target rotation!
          newRotation = this.rotationTarget;
        }
        this.rotation = newRotation;
      } else {
        // Rotating counterclockwise.
        let newRotation = this.rotation - this.speed*elapsed/1000;
        if (newRotation < this.rotationTarget) {
          // Reached target rotation!
          newRotation = this.rotationTarget;
        }
        this.rotation = newRotation;
      }
      this.rotationTime = now;
      setTimeout(() => {this.notifyUpdate()}, 0);
    } else {
      this.powerState.update(this.idleCurrent)
    }
    return this.rotation;
  }

  getState() {
    this.#updateRotation();
    let state = {
      id: this.id,
      properties: `rotation ${this.rotation.toFixed(1)}°`,
      cssProperties: {
        rotation: `${this.rotation}deg`,
      },
      power: this.powerState.getState(),
    };
    return state;
  }
}

// colorProperties returns --color and --shadow CSS custom properties for use
// in SVG files. The --shadow custom property is used to give the illusion of
// light coming off the LED and is partially transparent when not fully bright.
function colorProperties(components) {
  let [r, g, b] = components;
  let color = 'rgb(' + r + ', ' + g + ', ' + b + ')';
  let max = Math.max(r, g, b);
  let a = max / 255;
  if (max == 0) {
    r = 0;
    g = 0;
    b = 0;
  } else {
    r = r / max * 255;
    g = g / max * 255;
    b = b / max * 255;
  }
  let shadow = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  return {
    color: color,
    shadow: shadow,
  };
}

function encodeSRGB(channel) {
  return Math.pow(channel, 1/2.2) * 255;
}

// Decode an array of numbers (assumed to be bytes in the range 0-255) as a
// little-endian number.
function decodeLittleEndian(buf) {
  let n = 0;
  for (let i=0; i<buf.length; i++) {
    n |= (buf[i] << i*8);
  }
  return n;
}
