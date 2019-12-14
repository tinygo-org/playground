'use strict';

// This file implements devices commonly found on evaluation boards such as
// LEDs.

// An abstract base class for all kinds of devices.
class Device {
  constructor(config, container) {
    this.config = config;
    this.container = container;
  }

  get name() {
    return this.config.name;
  }
}

class LED extends Device {
  constructor(config, container) {
    super(config, container);
    this.cathode = new Pin(this, 'cathode');
    this.anode = new Pin(this, 'anode');
    container.innerHTML = '<div class="led off"></div>'
    if (config.color) {
      container.querySelector('.led').style.backgroundColor = config.color;
    }
  }

  get name() {
    return this.config.name || 'LED';
  }

  onupdate(pin) {
    let anode = this.anode.connected ? this.anode.net.isSource() : true;
    let cathode = this.cathode.connected ? this.cathode.net.isSink() : true;
    let on = anode && cathode; // only on when both are connected
    this.container.querySelector('.led').classList.toggle('off', !on)
  }
}

// An RGB LED which is present on some boards. Currently it emulates a common
// anode RGB LED with the 'cathodes' property listing the 3 pins (R, G, B).
class RGBLED extends Device {
  constructor(config, container) {
    super(config, container);
    this.red = new Pin(this, 'red');
    this.green = new Pin(this, 'green');
    this.blue = new Pin(this, 'blue');

    container.innerHTML = '<div class="led"></div>'
    if (config.color) {
      container.querySelector('.led').style.backgroundColor = 'black';
    }
  }

  onupdate(pin) {
    let red = '0', green = '0', blue = '0';
    if (this.red.isSink()) {
      red = '255';
    }
    if (this.green.isSink()) {
      green = '255';
    }
    if (this.blue.isSink()) {
      blue = '255';
    }
    let color = 'rgb(' + red + ',' + green + ',' + blue + ')';
    this.container.querySelector('.led').style.backgroundColor = color;
  }
}

// E-paper display by WaveShare.
// https://www.waveshare.com/w/upload/e/e6/2.13inch_e-Paper_Datasheet.pdf
class EPD2IN13 extends Device {
  constructor(config, container) {
    super(config, container);
    this.rotation = config.rotation % 4;
    this.width = 122;
    this.height = 250;
    this.sck = new Pin(this, 'sck');
    this.miso = new Pin(this, 'miso');
    this.mosi = new Pin(this, 'mosi');
    this.cs = new Pin(this, 'cs');
    this.dc = new Pin(this, 'dc');
    this.rst = new Pin(this, 'rst');
    this.busy = new Pin(this, 'busy');

    this.spi = new SPISlave(this.sck, this.mosi, this.miso, this.transferSPI.bind(this));

    // All operations are performed instantaneously.
    // Note that this is different from the EPD2IN13X driver. For the
    // EPD2IN13, low means ready and high means busy.
    // The datasheet appears to be wrong for the EPD2IN13.
    this.busy.setMode('output');
    this.busy.set(false); // not busy

    this.buffer = new Uint8Array(this.bufferWidth * Math.ceil(this.height / 8));
    this.command = null; // last command that was issued
    this.dataBuf = []; // bytes since last command
    this.addressX = 0;
    this.addressY = 0;

    container.innerHTML = '<canvas class="display"></canvas>';
    this.canvas = container.querySelector('canvas');
    if (this.rotation % 2 == 0) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    } else {
      this.canvas.height = this.width;
      this.canvas.width = this.height;
    }
    this.context = this.canvas.getContext('2d');
  }

  get name() {
    return this.config.name ? this.config.name : 'EPD2IN13';
  }

  // The buffer width is a bit bigger than the real display width.
  get bufferWidth() {
    return Math.ceil(this.width / 8) * 8;
  }

  onupdate(pin) {
  }

  transferSPI(w) {
    if (!this.cs.isLow()) {
      return;
    }
    if (this.dc.isHigh()) {
      // data
      if (this.dataBuf !== null) {
        this.dataBuf.push(w);
      }
      if (this.command == 0x24) {
        // Write RAM
        this.buffer[this.addressX + this.addressY * Math.ceil(this.bufferWidth/8)] = w;
        this.addressX++;
      } else if (this.command == 0x44) {
        // Specify the start/end positions of the window address in the Y
        // direction by an address unit
      } else if (this.command == 0x4e) {
        // Set RAM X address counter.
        this.addressX = decodeLittleEndian(this.dataBuf);
      } else if (this.command == 0x4f) {
        // Set RAM Y address counter.
        this.addressY = decodeLittleEndian(this.dataBuf);
      }
    } else {
      // command
      this.command = w;
      if (this.command == 0x20) {
        // Activate display update sequence.
        this.paint()
      } else if (this.command == 0x24) {
        // Do not buffer the "Write RAM" command.
      } else {
        this.dataBuf = [];
      }
    }
    return 0;
  }

  // Redraw the display based on the contents of the buffer.
  paint() {
    for (let x=0; x<this.width; x++) {
      for (let y=0; y<this.height; y++) {
        let byteIndex = Math.floor((x + y*this.bufferWidth) / 8);
        let blackSet = this.buffer[byteIndex] & (0x80 >> x%8);
        if (!blackSet) {
          this.context.fillStyle = 'black';
        } else {
          this.context.fillStyle = 'white';
        }
        let displayX = x;
        let displayY = y;
        if (this.rotation == 1) {
          displayX = this.height - y - 1;
          displayY = x;
        } else if (this.rotation == 2) {
          displayX = this.width - x - 1;
          displayY = this.height - y - 1;
        } else if (this.rotation == 3) {
          displayX = y;
          displayY = this.width - x - 1;
        }
        this.context.fillRect(displayX, displayY, 1, 1);
      }
    }
  }
}

// Tri-color e-paper display by WaveShare. There are red/black/white and
// yellow/black/white versions.
// https://www.waveshare.com/w/upload/d/d3/2.13inch-e-paper-b-Specification.pdf
class EPD2IN13X extends Device {
  constructor(config, container) {
    super(config, container);
    this.sck = new Pin(this, 'sck');
    this.miso = new Pin(this, 'miso');
    this.mosi = new Pin(this, 'mosi');
    this.cs = new Pin(this, 'cs');
    this.dc = new Pin(this, 'dc');
    this.rst = new Pin(this, 'rst');
    this.busy = new Pin(this, 'busy');

    this.spi = new SPISlave(this.sck, this.mosi, this.miso, this.transferSPI.bind(this));

    // All operations are performed instantaneously.
    this.busy.setMode('output');
    this.busy.set(true); // not busy

    this.bufferBlack = new Uint8Array(config.width * config.height / 8);
    this.bufferColor = new Uint8Array(config.width * config.height / 8);
    this.currentBuffer = null;
    this.currentBufferIndex = 0;

    container.innerHTML = '<canvas class="display"></canvas>';
    let canvas = container.querySelector('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    this.context = canvas.getContext('2d');
  }

  get name() {
    return this.config.name ? this.config.name : 'EPD2IN13';
  }

  onupdate(pin) {
  }

  transferSPI(w) {
    if (!this.cs.isLow()) {
      return;
    }
    if (this.dc.isHigh()) {
      if (this.currentBuffer && this.currentBufferIndex < this.currentBuffer.length) {
        this.currentBuffer[this.currentBufferIndex] = w;
        this.currentBufferIndex++;
      }
    } else {
      // command
      if (w == 0x10) {
        // B/W data
        this.currentBuffer = this.bufferBlack;
        this.currentBufferIndex = 0;
      } else if (w == 0x13) {
        this.currentBuffer = this.bufferColor;
        this.currentBufferIndex = 0;
      } else if (w == 0x12) {
        this.paint();
      }
    }
    return 0;
  }

  paint() {
    for (let x=0; x<this.config.width; x++) {
      for (let y=0; y<this.config.height; y++) {
        let byteIndex = Math.floor((x + y*this.config.width) / 8);
        let blackSet = this.bufferBlack[byteIndex] & (0x80 >> x%8);
        let colorSet = this.bufferColor[byteIndex] & (0x80 >> x%8);
        if (!blackSet && colorSet) {
          this.context.fillStyle = 'black';
        } else if (!colorSet) {
          // Use configured color, or default to yellow-ish.
          this.context.fillStyle = this.config.thirdColor || '#eebb22';
        } else {
          this.context.fillStyle = 'white';
        }
        this.context.fillRect(x, y, 1, 1);
      }
    }
  }
}

// ST7789 is a display controller for LCD screens up to 240x320 pixels.
// Datasheet:
// https://www.newhavendisplay.com/appnotes/datasheets/LCDs/ST7789V.pdf
class ST7789 extends Device {
  constructor(config, container) {
    super(config, container);
    this.sck = new Pin(this, 'sck');
    this.mosi = new Pin(this, 'mosi');
    this.cs = new Pin(this, 'cs');
    this.dc = new Pin(this, 'dc');
    this.reset = new Pin(this, 'reset');
    this.spi = new SPISlave(this.sck, this.mosi, null, this.transferSPI.bind(this));

    this.inReset = false;
    this.command = 0x00; // nop
    this.dataBuf = null;
    this.softwareReset();

    container.innerHTML = '<canvas class="display"></canvas>';
    let canvas = container.querySelector('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    this.context = canvas.getContext('2d');
  }

  get name() {
    return this.config.name ? this.config.name : 'ST7789';
  }

  onupdate(pin) {
    if (this.reset.isLow() != this.inReset) {
      this.inReset = this.reset.isLow();
      if (this.inReset) {
        this.softwareReset();
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
    this.currentColor = -1;
  }

  // Handle an incoming SPI byte.
  transferSPI(w) {
    if (!this.cs.isLow()) {
      return;
    }
    if (this.dc.isHigh()) {
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

          // Set the correct color, if it was different from the previous
          // color.
          if (this.currentColor != word) {
            this.currentColor = word;
            let red = Math.round((word >> 11) * 255 / 31);
            let green = Math.round(((word >> 5) & 63) * 255 / 63);
            let blue = Math.round((word & 31) * 255 / 31);
            this.context.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
          }

          // Draw the pixel.
          let x = this.x - (this.config.columnOffset || 0);
          let y = this.y - (this.config.rowOffset || 0);
          if (x >= 0 && y >= 0 && x < this.config.width && y < this.config.height) {
            this.context.fillRect(x, y, 1, 1);
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

class WS2812 extends Device {
  constructor(board, config, container) {
    super(board, config, container);
    this.din = new Pin(this, 'din');
    this.din.setWS2812Listener(this);

    this.chain = [];
    this.chainTimeout = null;
    this.chainToPaint = null;

    this.leds = [];
    container.innerHTML = '<div class="ws2812"><div class="ws2812-leds"></div></div>'
    let ledContainer = container.querySelector('.ws2812-leds');
    for (let i=0; i<config.length; i++) {
      let led = document.createElement('div');
      led.classList.add('ws2812-led');
      ledContainer.appendChild(led);
      this.leds.push(led);
    }
  }

  onupdate(pin) {
  }

  writeWS2812Byte(c) {
    this.chain.push(c);
    if (this.chainTimeout === null) {
      this.chainTimeout = setTimeout(() => {
        this.chainTimeout = null;

        if (this.chainToPaint === null) {
          window.requestAnimationFrame(this.paint.bind(this));
        }
        this.chain.reverse();
        this.chainToPaint = this.chain;
        this.chain = [];
      }, 0);
    }
  }

  paint() {
    for (let i=0; i<this.leds.length; i++) {
      let led = this.leds[i];
      if (i * 3 + 3 > this.chainToPaint.length) {
        break;
      }

      // Extract colors from the chain.
      // The colors are sent out in GRB order, but because they are swapped in
      // this driver they are in BRG order.
      let r = this.chainToPaint[i*3+1];
      let g = this.chainToPaint[i*3+2];
      let b = this.chainToPaint[i*3+0];

      // Do a gamma correction. The LEDs are in linear color space, while the
      // web uses the sRGB color space (with gamma=~2.2).
      // I'm not sure why the gamma needs to be this high (gamma=4), but that's
      // how I managed to get them sort-of similar to the real LEDs.
      // Without any gamma correction, the LEDs would look way too dark.
      r = Math.pow(r / 255, 1/4) * 255;
      g = Math.pow(g / 255, 1/4) * 255;
      b = Math.pow(b / 255, 1/4) * 255;

      let color = 'rgb(' + r + ',' + g + ',' + b + ')';
      led.style.background = color;
    }
    this.chainToPaint = null;
  }
}
