'use strict';

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
    for (let pin of pins) {
      if (pin.state === 'floating') {
        // no change
      } else if (pin.state === 'low') {
        if (state === 'high') {
          console.warn('short!'); // TODO: make this more informative
        }
        state = 'low';
      } else if (pin.state === 'high') {
        if (state === 'low') {
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
    return [state, nets];
  }

  // updateState updates the shared state of the net: low, high, or floating.
  // It also notifies connected devices that they have been updated.
  updateState() {
    let [newState, nets] = this.computeState();

    for (let net of nets) {
      if (net.state !== newState) {
        // The state changed. Notify listening parts.
        net.state = newState;
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
  constructor(sendConnections, sendNotifyUpdate) {
    this.parts = {};
    this.wires = [];
    // Don't send an update before the UI has requested an update. The UI will
    // request an update on load. The way this is implemented is by setting
    // hasUpdate to true at the beginning.
    this.hasUpdate = true;
    this.sendConnections = sendConnections;
    this.sendNotifyUpdate = sendNotifyUpdate;
    this.clock = new Clock();
    this.clock.start();
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
    console.error('part: ' + part.type);
    throw 'unknown part';
  }

  // removePart removes the part with the given ID. Call updateNets()
  // afterwards to update all connections (if any).
  removePart(id) {
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
      let [newState, nets] = net.computeState();
      net.state = newState;
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
    this.sendConnections(nets);
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

// Clock is a clock that starts at time 0 and can be paused and resumed.
// In the future, this clock might also support adjusting the speed at which it
// runs, so that time can be slowed down or sped up.
class Clock {
  constructor() {
    this.timeOrigin = 0;
    this.elapsed = 0;
    this.running = false;
    this.timeout = null;
    this.timeoutCallback = null;
    this.timeoutEnd = 0;
  }

  // Start or resume the clock.
  start() {
    this.timeOrigin = performance.now() - this.elapsed;
    this.running = true;
    if (this.timeoutCallback) {
      this.#startTimeout(this.timeoutCallback - this.timeOrigin);
    }
  }

  // Pause the clock at the current time.
  pause() {
    this.elapsed = this.now();
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  // Return the time (in milliseconds) from when the clock started running.
  now() {
    if (this.running) {
      return performance.now() - this.timeOrigin;
    } else {
      return this.elapsed;
    }
  }

  // Set a timeout, to be executed at the time as given in the timeout in
  // milliseconds.
  setTimeout(callback, milliseconds) {
    if (this.timeoutCallback) {
      console.error('setting timeout while a timeout is already running!');
    }
    this.timeoutCallback = callback;
    this.timeoutEnd = this.now() + milliseconds;
    if (this.running) {
      this.#startTimeout(milliseconds);
    }
  }

  #startTimeout(milliseconds) {
    this.timeout = setTimeout(() => {
      let callback = this.timeoutCallback;
      this.timeout = null;
      this.timeoutCallback = null;
      this.timeoutEnd = 0;
      callback();
    }, milliseconds);
  }
}
