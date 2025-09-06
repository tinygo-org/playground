'use strict';

const i2cErrorNoDevice = 1;
const i2cErrorMultipleDevices = 2;
const i2cErrorWrongAddress = 3;

// A net is a collection of pins that are all connected together through wires.
// None of the pins in the net have a connection to a pin that's not part of
// the net.
class Net {
  constructor(pin) {
    this.pins = new Set();
    this.addPin(pin);
    this.state = 'unknown';
  }

  // addPin adds a pin to this net and replaces the pin's net property.
  addPin(pin) {
    this.pins.add(pin);
    pin.net = this;
  }

  // computeState determines and returns the state of the net based on all pins
  // that are part of it.
  computeState() {
    let state = 'floating';
    let pins = new Set(this.pins);
    let nets = new Set([this]);
    let extra = null;
    for (let pin of pins) {
      if (pin.state === 'floating') {
        // no change
      } else if (pin.state === 'pwm') {
        state = 'pwm';
        extra = {period: pin.pwmPeriod, dutyCycle: pin.pwmDutyCycle};
      } else if (pin.state === 'low') {
        if (state === 'high' || state === 'pwm') {
          console.warn('short!'); // TODO: make this more informative
        }
        state = 'low';
      } else if (pin.state === 'high') {
        if (state === 'low' || state === 'pwm') {
          console.warn('short!'); // TODO: same here
        }
        state = 'high';
      } else if (pin.state === 'pullup') {
        if (state === 'pulldown') {
          console.warn('pulldown+pullup, reverting back to floating');
          state = 'floating';
        } else if (state === 'floating') {
          state = 'pullup';
        }
      } else if (pin.state === 'pulldown') {
        if (state === 'pullup') {
          console.warn('pulldown+pullup, reverting back to floating');
          state = 'floating';
        } else if (state === 'floating') {
          state = 'pulldown';
        }
      } else if (pin.state === 'connected') {
        // Special pin state that indicates this is a connection that can be
        // broken (like in a push button or switch). Implement it by also
        // looking at all the pins in the net of the connected pin.
        nets.add(pin.connected.net);
        for (let otherPin of pin.connected.net.pins) {
          pins.add(otherPin);
        }
      } else {
        console.error('unknown pin state:', pin.state);
      }
    }
    return [state, extra, nets];
  }

  // updateState updates the shared state of the net: low, high, or floating.
  // It also notifies connected devices that they have been updated.
  updateState() {
    let [newState, extra, nets] = this.computeState();

    for (let net of nets) {
      if (net.state !== newState || extra) {
        // The state changed. Notify listening parts.
        net.state = newState;
        net.extra = extra;
        for (let pin of net.pins) {
          pin.notifyPart();
        }
      }
    }
  }

  // isHigh returns whether this pin is currently pulled high. It returns false
  // for floating pins. Used for digital inputs.
  isHigh() {
    return this.state === 'high' || this.state === 'pullup';
  }

  // isLow returns whether this pin is currently pulled low. It returns false
  // for floating pins. Used for digital inputs.
  isLow() {
    return this.state === 'low' || this.state === 'pulldown';
  }

  // isSource returns whether this pin is a source of current (such as VCC or a
  // high pin, but not a pulled up input pin). Used for LEDs.
  isSource() {
    return this.state === 'high' || this.state === 'pwm';
  }

  // isSink returns whether this pin is a current sink (such as GND or a low
  // pin, but not a pulled down input pin). Used for LEDs.
  isSink() {
    return this.state == 'low' || this.state === 'pwm';
  }
}

// The schematic tracks all electronic parts and the connections between them.
class Schematic {
  constructor(powerTabVisible) {
    this.parts = {};
    this.wires = [];
    this.needsContinuousUpdates = new Set();
    this.powerUpdate = null;
    this.powerTabVisible = powerTabVisible;
    // Don't send an update before the UI has requested an update. The UI will
    // request an update on load. The way this is implemented is by setting
    // hasUpdate to true at the beginning.
    this.hasUpdate = true;
  }

  // addPart adds a single part to the schematic.
  // Call updateNets() afterwards to update all connections.
  addPart(part) {
    let instance = this.makePart(part);
    this.parts[part.id] = instance;
    return instance;
  }

  // makePart creates a new part object, based on the input configuration
  // object.
  // This is a private method.
  makePart(part) {
    if (part.type === 'board')
      return new Board(this, part);
    if (part.type === 'dummy')
      return new Dummy(this, part);
    if (part.type === 'mcu')
      return new MCU(this, part);
    if (part.type === 'pushbutton')
      return new Button(this, part);
    if (part.type === 'led')
      return new LED(this, part);
    if (part.type === 'rgbled')
      return new RGBLED(this, part);
    if (part.type === 'ws2812')
      return new WS2812(this, part);
    if (part.type === 'epd2in13')
      return new EPD2IN13(this, part);
    if (part.type === 'st7789')
      return new ST7789(this, part);
    if (part.type === 'servo')
      return new Servo(this, part);
    console.error('part: ' + part.type);
    throw 'unknown part';
  }

  // removePart removes the part with the given ID. Call updateNets()
  // afterwards to update all connections (if any).
  removePart(id) {
    this.needsContinuousUpdates.delete(this.parts[id]);
    delete this.parts[id];
  }

  // addWire adds a new wire between two parts identified by its full ID.
  // Call updateNets() afterwards to update all connections.
  addWire(from, to) {
    this.wires.push({
      from: this.getPin(from),
      to  : this.getPin(to),
    });
  }

  // removeWire removes the given wire identified by the pin IDs. The IDs must
  // be in the correct order.
  // Call updateNets() afterwards to update all connections.
  removeWire(from, to) {
    for (let i=0; i<this.wires.length; i++) {
      let wire = this.wires[i];
      if (from === wire.from.id && to === wire.to.id) {
        this.wires.splice(i, 1);
        return;
      }
    }
    // Could not find wire to remove (this is an error).
    console.warn('could not remove wire:', from, to);
  }

  // updateNets recalculates all nets so that parts can quickly know which pins
  // (of other parts) are connected to a particular pin and quickly sense its
  // state (high, low, floating).
  updateNets() {
    // Put each pin in its own net (to be merged later).
    let nets = {};
    let oldPinStates = {};
    for (let part of Object.values(this.parts)) {
      for (let pin of Object.values(part.pins)) {
        oldPinStates[pin.id] = pin.net ? pin.net.state : 'unknown';
        nets[pin.id] = new Net(pin);
      }
    }

    // Merge all nets that are connected together through a wire.
    for (let wire of this.wires) {
      let fromNet = nets[wire.from.id];
      let toNet = nets[wire.to.id];
      for (let pin of fromNet.pins) {
        toNet.addPin(pin);
        nets[pin.id] = toNet;
      }
    }

    // Calculate new pin state for each net.
    let updatedNets = new Set();
    for (let net of Object.values(nets)) {
      if (updatedNets.has(net)) {
        continue;
      }
      let [newState, extra, nets] = net.computeState();
      net.state = newState;
      net.extra = extra;
      updatedNets.add(net);
    }

    // Notify the changed state, if the pin changed state.
    for (let net of updatedNets) {
      for (let pin of net.pins) {
        if (net.state !== oldPinStates[pin.id]) {
          pin.notifyPart();
        }
      }
    }

    // Send the new netlist to the frontend.
    let connections = [];
    for (let net of Object.values(nets)) {
      let pinIds = [];
      for (let pin of net.pins) {
        pinIds.push(pin.id);
      }
      connections.push(pinIds);
    }
    postMessage({
      type: 'connections',
      pinLists: connections,
    });
  }

  // getPin returns a pin by its full name, such as arduino.led.anode.
  getPin(id) {
    let index = id.lastIndexOf('.');
    let partID = id.slice(0, index);
    let pinID = id.slice(index+1);
    return this.getPart(partID).getPin(pinID);
  }

  // getPart returns a part instance by its full name, such as
  // arduino.atmega328p.
  getPart(id) {
    let part = this.parts[id];
    if (!part) {
      console.error('part:', id);
      throw 'getPart: unknown part';
    }
    return part;
  }

  // notifyUpdate marks the schematic as needing an update. After this signal,
  // the UI will request updates in a requestAnimationFrame handler.
  notifyUpdate() {
    if (this.hasUpdate)
      // Already notified.
      return;

    // There was an update. Notify the frontend.
    this.hasUpdate = true;
    postMessage({
      type: 'notifyUpdate',
    });
  }

  // Mark the given part as needing continuous updates.
  updatePowerContinuously(part) {
    this.needsContinuousUpdates.add(part);
    if (!this.needsContinuousUpdates.length) {
      this.#updateContinuousPowerUpdates();
    }
  }

  // Check whether we need to continuously update power usage and start/stop the
  // updating of average power.
  #updateContinuousPowerUpdates() {
    let needsUpdates = this.powerTabVisible && this.needsContinuousUpdates.size;
    if (needsUpdates && !this.powerUpdateInterval) {
      // Start updating power.
      this.powerUpdateInterval = setInterval(() => {
        let powerUpdates = {};
        for (let part of this.needsContinuousUpdates) {
          // TODO: only push avg power?
          powerUpdates[part.id] = part.powerState.getState();
        }
        postMessage({
          type: 'powerUpdates',
          updates: powerUpdates,
        })
      }, 100);
    } else if (!needsUpdates && this.powerUpdateInterval) {
      // Stop updating power.
      clearTimeout(this.powerUpdateInterval);
      this.powerUpdateInterval = null;
    }
  }

  // Set whether the power tab is visible. This information is sent by the UI.
  setPowerTabVisible(visible) {
    this.powerTabVisible = visible;
    this.#updateContinuousPowerUpdates();
  }

  // Return property types for each part that has properties.
  getPropertyTypes() {
    let properties = [];
    for (let part of Object.values(this.parts)) {
      if (part.properties) {
        properties.push(part.properties);
      }
    }
    return properties;
  }

  // Return a tree of devices where a parent consumes the power of each child
  // combined. It doesn't contain power values itself, only a tree of devices
  // that will report power consumption when updating.
  getPowerTree() {
    // Find all devices.
    let devices = {};
    for (let part of Object.values(this.parts)) {
      if (part.power) {
        devices[part.id] = {
          node: part.power,
          children: [],
        };
      }
    }

    // Construct the tree.
    let tree = [];
    for (let part of Object.values(devices)) {
      if (part.node.source && part.node.source in devices) {
        devices[part.node.source].children.push(part);
      } else {
        tree.push(part);
      }
    }
    return tree;
  }

  // getUpdates returns an array of updates to be applied in the UI.
  // This method changes state: after it, all parts are marked as not having an
  // update.
  getUpdates() {
    this.hasUpdate = false;
    let updates = [];
    for (let [id, part] of Object.entries(this.parts)) {
      if (!part.hasUpdate)
        continue; // no updates from this part
      updates.push(part.getState());
      part.hasUpdate = false;
    }
    return updates;
  }
}

// A SPIBus (SPI: Serial Peripheral Interface) can be both a controller or a
// peripheral, depending on how it is configured.
class SPIBus {
  configureAs(mode, sck, sdo, sdi) {
    this.mode = mode;
    // sdo or sdi might not be present (e.g. when a SPI bus is send-only or
    // receive-only).
    if (sdo)
      sdo.setState('low');
    if (sdi)
      sdi.setState('low');
    this.sck = sck;
    this.sdo = sdo;
    this.sdi = sdi;
  }

  // Configure this SPI bus as a controller, e.g. how it's commonly used in
  // MCUs.
  configureAsController(sck, sdo, sdi) {
    sck.setState('low', 'spi-sck-out');
    this.configureAs('controller', sck, sdo, sdi);
  }

  // Configure this SPI bus as a peripheral, e.g. how it's commonly used in
  // peripheral devices like displays.
  configureAsPeripheral(sck, sdo, sdi) {
    sck.setState('low', 'spi-sck-in');
    this.configureAs('peripheral', sck, sdo, sdi);
  }

  // Send/receive a single byte, communicating with all connected devices at
  // once. Return the byte resulting from this.
  transfer(w) {
    if (this.mode !== 'controller') {
      console.warn('sending on a non-controller SPI bus:', this.sck.id);
      return;
    }
    let r;
    for (let pin of this.sck.net.pins) {
      if (pin.mode !== 'spi-sck-in')
        continue;
      let value = pin.part.transferSPI(pin, w);
      if (typeof value === 'number') {
        if (typeof r === 'number') {
          console.warn('more than one SPI bus returned a value when sending on pin', this.sck.id);
        }
        r = value;
      }
    }
    if (typeof value !== 'number') {
      if (this.sdi.net.isLow()) {
        r = 0x00;
      } else if (this.sdi.net.isHigh()) {
        r = 0xff;
      } else {
        // All connected devices (if any) are floating, so return a random
        // value to simulate the real world somewhat.
        // Note that Math.rand() will never return 1, so the value below will
        // always be in the 0..255 range.
        r = Math.floor(Math.rand() * 256);
      }
    }
    return r;
  }
}

class I2CBus {
  configureAsController(scl, sda) {
    this.scl = scl;
    this.sda = sda;
    this.mode = 'controller';
    scl.setState('pullup', 'i2c-scl-out');
    sda.setState('pullup');
  }

  configureAsPeripheral(scl, sda) {
    this.scl = scl;
    this.sda = sda;
    this.mode = 'controller';
    scl.setState('pullup', 'i2c-scl-in');
    sda.setState('pullup');
  }

  transfer(address, w, r) {
    if (this.mode !== 'controller') {
      console.warn('sending on a non-controller I2C bus:', this.scl.id);
    }

    let devices = [];
    let totalDevices = 0;
    for (let pin of this.scl.net.pins) {
      if (pin.mode !== 'i2c-scl-in')
        continue;
      totalDevices++;
      // TODO: also check SDA pin
      if (pin.part.hasI2CAddress(address)) {
        devices.push(pin.part);
      }
    }
    if (devices.length == 0) {
      if (totalDevices > 0) {
        return i2cErrorWrongAddress;
      }
      return i2cErrorNoDevice;
    } else if (devices.length > 1) {
      return i2cErrorMultipleDevices;
    } else {
      devices[0].transferI2C(w, r);
      return 0;
    }
  }
}

// A PWM instance simulates a single PWM/timer peripheral as commonly exists on
// microcontrollers.
class PWMInstance {
  configure(instance, frequency, top) {
    this.instance = instance;
    this.frequency = frequency;
    this.top = top;
    this.channels = new Map();
  }

  // Configure a channel to use the given pin.
  // One channel may be connected to multiple pins.
  channelConfigure(channel, pin) {
    // Add the pin to this channel. One channel might control multiple pins
    // (that's how the hardware usually works).
    if (!this.channels.has(channel)) {
      this.channels.set(channel, {
        pins: new Set(),
        value: 0,
      });
    }
    this.channels.get(channel).pins.add(pin);

    // Set the pin as a PWM output.
    pin.setState('pwm', 'pwm');
  }

  // Set the value (duty cycle) of the channel.
  channelSet(channel, value) {
    if (!this.channels.has(channel)) {
      throw new Error(`channel ${channel} of PWM instance ${this.instance} has not been configured`)
    }

    let ch = this.channels.get(channel)
    ch.value = value;
    this.#updatePins(ch);
  }

  #updatePins(ch) {
    let period = this.top / this.frequency * 1000; // period in ms
    let dutyCycle = ch.value / this.top;
    if (dutyCycle > 1) {
      dutyCycle = 1;
    }
    for (let outPin of ch.pins) {
      outPin.setPWM(period, dutyCycle);
    }
  }
}
