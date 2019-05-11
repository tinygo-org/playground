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
    this.update();
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
