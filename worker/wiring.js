'use strict';

if (typeof module !== 'undefined') {
  for (let [key, value] of Object.entries(require('./parts.js'))) {
    global[key] = value;
  }
}

// A net is a collection of pins that are all connected together through wires.
// None of the pins in the net have a connection to a pin that's not part of
// the net.
class Net {
  constructor(pin) {
    this.pins = new Set();
    this.addPin(pin);
    this.state = pin.state;
  }

  // addPin adds a pin to this net and replaces the pin's net property.
  addPin(pin) {
    this.pins.add(pin);
    pin.net = this;
  }

  // updateState updates the shared state of the net: low, high, or floating.
  // It also notifies connected devices that they have been updated.
  updateState() {
    let oldState = this.state;
    this.state = 'floating';
    for (let pin of this.pins) {
      if (pin.state === 'floating') {
        // no change
      } else if (pin.state === 'low') {
        if (this.state === 'high') {
          console.warn('short!'); // TODO: make this more informative
        }
        this.state = 'low';
      } else if (pin.state === 'high') {
        if (this.state === 'low') {
          console.warn('short!'); // TODO: same here
        }
        this.state = 'high';
      } else {
        console.error('unknown pin state:', pin.state);
      }
    }

    // The state changed. Notify listening devices.
    if (this.state !== oldState) {
      for (let pin of this.pins) {
        if (pin.state === 'low' || pin.state === 'high') {
          // Nothing to notify: can't read the state.
          continue;
        }
        pin.part.notifyPinUpdate(pin);
      }
    }
  }

  // isHigh returns whether this pin is currently pulled high. It returns false
  // for floating pins. Used for digital inputs.
  isHigh() {
    return this.state == 'high';
  }

  // isLow returns whether this pin is currently pulled low. It returns false
  // for floating pins. Used for digital inputs.
  isLow() {
    return this.state == 'low';
  }

  // isSource returns whether this pin is a source of current (such as VCC or a
  // high pin, but not a pulled up input pin). Used for LEDs.
  isSource() {
    return this.state == 'high';
  }

  // isSink returns whether this pin is a current sink (such as GND or a low
  // pin, but not a pulled down input pin). Used for LEDs.
  isSink() {
    return this.state == 'low';
  }
}

// The schematic tracks all electronic parts and the connections between them.
class Schematic {
  constructor(sendNotifyUpdate) {
    this.parts = {};
    this.wires = [];
    // Don't send an update before the UI has requested an update. The UI will
    // request an update on load. The way this is implemented is by setting
    // hasUpdate to true at the beginning.
    this.hasUpdate = true;
    this.sendNotifyUpdate = sendNotifyUpdate;
  }

  // addPart adds a single part to the schematic.
  // Call updateNets() afterwards to update all connections.
  addPart(part) {
    let instance = this.makePart(part);
    this.parts[part.id] = instance;
  }

  // makePart creates a new part object, based on the input configuration
  // object.
  // This is a private method.
  makePart(part) {
    if (part.type === 'mcu')
      return new MCU(this, part);
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
    console.error('part: ' + part.type);
    throw 'unknown part';
  }

  // addWire adds a new wire between two parts identified by its full ID.
  // Call updateNets() afterwards to update all connections.
  addWire(from, to) {
    this.wires.push({
      from: this.getPin(from),
      to  : this.getPin(to),
    });
  }

  // updateNets recalculates all nets so that parts can quickly know which pins
  // (of other parts) are connected to a particular pin and quickly sense its
  // state (high, low, floating).
  updateNets() {
    // Put each pin in its own net (to be merged later).
    let nets = {};
    for (let part of Object.values(this.parts)) {
      for (let pin of Object.values(part.pins)) {
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

    // Update state of all nets.
    let updatedNets = new Set();
    for (let net of Object.values(nets)) {
      if (updatedNets.has(net))
        continue;
      net.updateState();
      updatedNets.add(net);
    }
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
    this.sendNotifyUpdate();
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

if (typeof module !== 'undefined') {
  module.exports.Schematic = Schematic;
}
