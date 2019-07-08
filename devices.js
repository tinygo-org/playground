'use strict';

// This file implements devices commonly found on evaluation boards such as
// LEDs.

// An abstract base class for all kinds of devices.
class Device {
  constructor(board, config, container) {
    this.board = board;
    this.config = config;
    this.container = container;
  }
}

class LED extends Device {
  constructor(board, config, container) {
    super(board, config, container);
    if ('cathode' in config) {
      this.cathode = board.getPin(config.cathode);
      this.cathode.attach(this);
    }
    if ('anode' in config) {
      this.anode = board.getPin(config.anode);
      this.anode.attach(this);
    }

    container.innerHTML = '<div class="led off"></div>'
    if (config.color) {
      container.querySelector('.led').style.backgroundColor = config.color;
    }
  }

  update() {
    let anode = true;
    if (this.anode) {
      anode = this.anode.isSource();
    }
    let cathode = true;
    if (this.cathode) {
      cathode = this.cathode.isSink();
    }
    let on = anode && cathode; // only on when both are connected
    this.container.querySelector('.led').classList.toggle('off', !on)
  }
}

// An RGB LED which is present on some boards. Currently it emulates a common
// anode RGB LED with the 'cathodes' property listing the 3 pins (R, G, B).
class RGBLED extends Device {
  constructor(board, config, container) {
    super(board, config, container);
    if ('cathodes' in config && config.cathodes.length == 3) {
      this.red = board.getPin(config.cathodes[0]);
      this.green = board.getPin(config.cathodes[1]);
      this.blue = board.getPin(config.cathodes[2]);
      this.red.attach(this);
      this.green.attach(this);
      this.blue.attach(this);
    }

    container.innerHTML = '<div class="led"></div>'
    if (config.color) {
      container.querySelector('.led').style.backgroundColor = 'black';
    }
  }

  update() {
    let red = '0', green = '0', blue = '0';
    if (this.red && this.red.isSink()) {
      red = '255';
    }
    if (this.green && this.green.isSink()) {
      green = '255';
    }
    if (this.blue && this.blue.isSink()) {
      blue = '255';
    }
    let color = 'rgb(' + red + ',' + green + ',' + blue + ')';
    this.container.querySelector('.led').style.backgroundColor = color;
  }
}

// E-paper display by WaveShare.
// https://www.waveshare.com/w/upload/e/e6/2.13inch_e-Paper_Datasheet.pdf
class EPD2IN13 extends Device {
  constructor(board, config, container) {
    super(board, config, container);
    this.rotation = config.rotation % 4;
    this.width = 122;
    this.height = 250;
    this.sck = board.getPin(config.sck);
    this.miso = board.getPin(config.miso);
    this.mosi = board.getPin(config.mosi);
    this.cs = board.getPin(config.cs);
    this.dc = board.getPin(config.dc);
    this.rst = board.getPin(config.rst);
    this.busy = board.getPin(config.busy);

    this.rst.attach(this);
    this.busy.attach(this);
    this.sck.attach(this);

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

  // The buffer width is a bit bigger than the real display width.
  get bufferWidth() {
    return Math.ceil(this.width / 8) * 8;
  }

  update() {
  }

  sensePin(pin) {
    if (pin == this.busy) {
      // All operations are performed instantaneously.
      // Note that this is different from the EPD2IN13X driver. For the
      // EPD2IN13, we low means ready and high means busy.
      // The datasheet appears to be wrong for the EPD2IN13.
      return false;
    }
  }

  transferSPI(sck, mosi, miso, w) {
    if (!this.cs.isLow()) {
      return;
    }
    if (sck == this.sck && mosi == this.mosi) {
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
      if (miso == this.miso) {
        return 0;
      }
    }
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

class EPD2IN13X extends Device {
  constructor(board, config, container) {
    super(board, config, container);
    this.sck = board.getPin(config.sck);
    this.miso = board.getPin(config.miso);
    this.mosi = board.getPin(config.mosi);
    this.cs = board.getPin(config.cs);
    this.dc = board.getPin(config.dc);
    this.rst = board.getPin(config.rst);
    this.busy = board.getPin(config.busy);

    this.rst.attach(this);
    this.busy.attach(this);
    this.sck.attach(this);

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

  update() {
  }

  sensePin(pin) {
    if (pin == this.busy) {
      // All operations are performed instantaneously.
      return true;
    }
  }

  transferSPI(sck, mosi, miso, w) {
    if (!this.cs.isLow()) {
      return;
    }
    if (sck == this.sck && mosi == this.mosi) {
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
      if (miso == this.miso) {
        return 0;
      }
    }
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
          this.context.fillStyle = this.config.thirdColor;
        } else {
          this.context.fillStyle = 'white';
        }
        this.context.fillRect(x, y, 1, 1);
      }
    }
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
