'use strict';

// Base class for all electronic parts.
class Part {
  constructor(schematic, config) {
    this.schematic = schematic;
    this.id = config.id;
    this.type = config.type;
    this.pins = {};
    this.spiBuses = {};
    this.hasUpdate = false;
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

  // Notify that one of the pins of this part has changed in state.
  // This can be overridden in subclasses, but the default action is to mark
  // the part as needing updates.
  notifyPinUpdate() {
    this.notifyUpdate();
  }

  // notifyUpdate marks this part as having an update to be sent to the UI.
  notifyUpdate() {
    if (this.hasUpdate)
      return; // already notified
    this.hasUpdate = true;
    schematic.notifyUpdate();
  }

  // getState sends the current state to the UI.
  // It's a stub, subclasses should properly implement it.
  getState() {
    console.warn('unimplemented: getState for', this.type);
    return {
      id: this.id,
    };
  }
}

// MCU implements a MCU like part, that runs a program, logs to stdout, and
// usually has lots of GPIO pins.
class MCU extends Part {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins[255] = new Pin(config.id + '.NoPin', this);
    for (let [name, number] of Object.entries(config.pins)) {
      let pin = new Pin(config.id + '.' + name, this);
      this.pins[name] = pin;
      this.pins[number] = pin;
    }
    this.logBuffer = [];
  }

  notifyPinUpdate() {
    // Nothing to do. Pin changes do not affect the display of an MCU (unlike
    // an LED for example).
  }

  getState() {
    // Send the text that was written to stdout since the last call to getState().
    let text = (new TextDecoder('utf-8')).decode(new Uint8Array(this.logBuffer));
    this.logBuffer = [];
    return {
      id: this.id,
      logText: text,
    };
  }
}

// LEDBase is a base class for any kind of LED (monochromatic, RGB, etc).
class LEDBase extends Part {
  getState() {
    let [r, g, b] = this.getColor();
    let color = 'rgb(' + r + ', ' + g + ', ' + b + ')';
    return {
      id: this.id,
      cssProperties: {
        color: color,
      },
    };
  }
}

// LED is a regular monochromatic LED with two pins.
// This implementation has the special property that if a wire is not
// connected, it shows as "on". That's to simplify wiring of them.
class LED extends LEDBase {
  constructor(schematic, config) {
    super(schematic, config);
    this.color = config.color;
    this.pins.anode = new Pin(config.id + '.anode', this);
    this.pins.cathode = new Pin(config.id + '.cathode', this);
    this.notifyUpdate();
  }

  getColor() {
    let anode = this.pins.anode.isConnected() ? this.pins.anode.net.isSource() : true;
    let cathode = this.pins.cathode.isConnected() ? this.pins.cathode.net.isSink() : true;
    let on = anode && cathode;
    let [r, g, b] = this.color;
    if (!on) {
      // Reduce the brightness, but don't go all the way to black.
      // Many LEDs (especially through-hole LEDs) are embedded in colored
      // plastic, so they still have a particular color even when they're off.
      r = Math.floor(encodeSRGB(decodeSRGB(r) / 7));
      g = Math.floor(encodeSRGB(decodeSRGB(g) / 7));
      b = Math.floor(encodeSRGB(decodeSRGB(b) / 7));
    }
    return [r, g, b];
  }
}

// RGBLED is a typical common anode RGB LED, meaning that it has four wires of
// which one is connected to VCC and the other three can be set to low to turn
// them on.
class RGBLED extends LEDBase {
  constructor(schematic, config) {
    super(schematic, config);
    this.pins.r = new Pin(config.id + '.r', this);
    this.pins.g = new Pin(config.id + '.g', this);
    this.pins.b = new Pin(config.id + '.b', this);
    this.notifyUpdate();
  }

  getColor() {
    return [
      this.pins.r.net.isSink() ? 255 : 0,
      this.pins.g.net.isSink() ? 255 : 0,
      this.pins.b.net.isSink() ? 255 : 0,
    ];
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
    let imageData = new ImageData(this.width, this.height);
    for (let x=0; x<this.width; x++) {
      for (let y=0; y<this.height; y++) {
        let byteIndex = Math.floor((x + y*this.bufferWidth) / 8);
        let whiteSet = this.buffer[byteIndex] & (0x80 >> x%8);
        let index = 4 * (y*this.width + x);
        if (whiteSet) {
          imageData.data[index+0] = 255; // R
          imageData.data[index+1] = 255; // G
          imageData.data[index+2] = 255; // B
        } else {
          imageData.data[index+0] = 0; // R
          imageData.data[index+1] = 0; // G
          imageData.data[index+2] = 0; // B
        }
        imageData.data[index+3] = 255; // A
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

    this.imageData = new ImageData(this.width, this.height);
    this.inReset = false;
    this.command = 0x00; // nop
    this.dataBuf = null;
    this.softwareReset();
  }

  notifyPinUpdate(pin) {
    if (this.pins.reset.net.isLow() != this.inReset) {
      this.inReset = this.pins.reset.net.isLow();
      if (this.inReset) {
        this.softwareReset();
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

    // Give these a sensible default value. Will be updated with the RAMWR
    // command.
    this.x = 0;
    this.y = 0;
    this.dataByte = null;
  }

  // Handle an incoming SPI byte.
  transferSPI(sck, w) {
    if (!this.pins.cs.net.isLow()) {
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
          console.error('st7789: xs must be smaller than or equal to xe');
        }
      } else if (this.command == 0x2b && this.dataBuf.length == 4) {
        // RASET: row address set
        this.ys = (this.dataBuf[0] << 8) + this.dataBuf[1];
        this.ye = (this.dataBuf[2] << 8) + this.dataBuf[3];
        if (this.ys > this.ye) {
          console.error('st7789: ys must be smaller than or equal to ye');
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

          // Draw the pixel.
          let x = this.x;
          let y = this.y;
          if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
            // TODO: just write to a memory buffer and only create the image
            // data in this.getState.
            let red = Math.round((word >> 11) * 255 / 31);
            let green = Math.round(((word >> 5) & 63) * 255 / 63);
            let blue = Math.round((word & 31) * 255 / 31);
            let index = 4 * (y*this.height + x);
            this.imageData.data[index+0] = red;
            this.imageData.data[index+1] = green;
            this.imageData.data[index+2] = blue;
            this.imageData.data[index+3] = 0xff; // alpha channel
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
        if (this.dataBuf[0] != 0xc0) {
          console.warn('st7789: unknown MADCTL value:', this.dataBuf[0]);
        }
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
        // SLPOUT: nothing to do
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
      } else {
        // unknown command
        console.log('st7789: unknown command:', w);
      }
    }
    return 0;
  }

  getState() {
    // Send the image data.
    return {
      id: this.id,
      canvas: this.imageData,
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
    this.data = new Uint8Array(this.length * 3);
    this.notifyUpdate();
  }

  writeWS2812(c) {
    // TODO: support incomplete writes with timeouts.
    // TODO: do something smarter than a memcpy here. It's fine for small LED
    // strips but it may be rather expensive with long strips as it's O(n²).
    this.data.set(this.data.slice(0, -1), 1);
    this.data[0] = c;
    this.notifyUpdate();
  }

  getState() {
    // Calculate the buffer of RGB values to send to the UI.
    let data = new Uint8Array(this.length * 3);
    for (let i=0; i < this.length; i++) {
      // Extract data from the array. Note that the data is in GRB order, at
      // least on most chips. TODO: make this configurable.
      let r = this.data[i*3+1];
      let g = this.data[i*3+0];
      let b = this.data[i*3+2];

      // Do a gamma correction. The LEDs are in linear color space, while the
      // web uses the sRGB color space (with gamma=~2.2).
      // Without any gamma correction, the LEDs would look way too dark.
      r = encodeSRGB(r / 255);
      g = encodeSRGB(g / 255);
      b = encodeSRGB(b / 255);

      // Put outgoing data in normal RGB order.
      data[i*3+0] = r;
      data[i*3+1] = g;
      data[i*3+2] = b;
    }

    // Send the resulting data.
    return {
      id: this.id,
      ledstrip: data,
    };
  }
}

function decodeSRGB(channel) {
  return Math.pow(channel / 255, 2.2);
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