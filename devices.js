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

    container.innerHTML = '<div class="led"><div class="led-mask"></div></div>'
    if (config.color) {
      container.querySelector('.led').style.background = config.color;
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
    this.container.querySelector('.led').classList.toggle('on', on)
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
        //console.log('data:', w);
        if (this.currentBuffer && this.currentBufferIndex < this.currentBuffer.length) {
          this.currentBuffer[this.currentBufferIndex] = w;
          this.currentBufferIndex++;
        }
      } else {
        // command
        if (w == 0x10) {
          // B/W data
          console.log('b/w data');
          this.currentBuffer = this.bufferBlack;
          this.currentBufferIndex = 0;
        } else if (w == 0x13) {
          console.log('colored data');
          this.currentBuffer = this.bufferColor;
          this.currentBufferIndex = 0;
        } else if (w == 0x12) {
          console.log('display refresh');
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
        //console.log('bits:', this.bufferBlack[byteIndex] & (0x80 >> x%8), this.bufferBlack[byteIndex], x, byteIndex);
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
