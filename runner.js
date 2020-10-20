'use strict';

// This file loads and executes some WebAssembly compiled by TinyGo.

class Runner {
  constructor(response) {
    this.logLine = [];
    this.timeout = null;
    let importObject = {
      // Bare minimum syscall/js environment, to get time.Sleep to work.
      wasi_unstable: {
        fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => this.logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr),
      },
      env: {
        'runtime.ticks': () =>
          performance.now() - this._timeOrigin,
        'runtime.sleepTicks': (timeout) =>
          this.timeout = setTimeout(this._inst.exports.go_scheduler, timeout),
        'syscall/js.finalizeRef': () =>
          console.error('js.finalizeRef is not supported'),
        'syscall/js.stringVal': () =>
          console.error('js.stringVal is not supported'),
        'syscall/js.valueCall': () =>
          console.error('js.FuncOf is not supported'),
        'syscall/js.valueNew': () =>
          console.error('js.New is not supported'),
        'syscall/js.valueSetIndex': () =>
          console.error('js.Value.SetIndex is not supported'),
        'syscall/js.valueGet': (retval, v_addr, p_ptr, p_len) =>
          this.envValueGet(retval, v_addr, p_ptr, p_len),
        'syscall/js.valueIndex': () =>
          console.error('js.valueIndexis not supported'),
        'syscall/js.valueLength': () =>
          console.error('js.valueLength is not supported'),
        'syscall/js.valueLoadString': (v_addr, slice_ptr, slice_len, slice_cap) =>
          this.envValueLoadString(v_addr, slice_ptr, slice_len, slice_cap),
        'syscall/js.valuePrepareString': (ret_addr, v_addr) =>
          this.envValuePrepareString(ret_addr, v_addr),
        'syscall/js.valueSet': () =>
          console.error('js.valueSet is not supported'),
        __tinygo_gpio_set: (pin, high) =>
          board.getPin(pin).set(high ? true : false),
        __tinygo_gpio_get: (pin, high) =>
          board.getPin(pin).get(),
        __tinygo_gpio_configure: (pin, mode) =>
          board.getPin(pin).setMode({
            0: 'input',
            1: 'output',
          }[mode]),
        __tinygo_spi_configure: (bus, sck, mosi, miso) => {
          board.getSPI(bus).configure(board.getPin(sck), board.getPin(mosi), board.getPin(miso));
        },
        __tinygo_spi_transfer: (bus, w) => {
          return board.getSPI(bus).transfer(w);
        },
        __tinygo_ws2812_write_byte: (pinNumber, c) => {
          for (let pin of board.getPin(pinNumber).net.pins) {
            if (pin.ws2812Listener === null) continue;
            pin.ws2812Listener.writeWS2812Byte(c);
          }
        },
      },
    };
    if ('instantiateStreaming' in WebAssembly) {
      WebAssembly.instantiateStreaming(response, importObject)
      .then(this.onload.bind(this))
      .catch(log);
    } else {
      response.arrayBuffer().then(bytes =>
        WebAssembly.instantiate(bytes, importObject).then(this.onload.bind(this))
      ).catch(log);
    }
  }

  onload(result) {
    this._timeOrigin = performance.now();
    this._inst = result.instance;
    this._refs = new Map();
    this._values = [
      NaN,
      0,
      null,
      true,
      false,
      { // global
        fs: {
          constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
        },
      },
      this._inst.exports.memory,
      this,
    ];
    this._inst.exports._start();
  }

  stop() {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  envMem() {
    return new DataView(this._inst.exports.memory.buffer)
  }

  logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr) {
    // https://github.com/bytecodealliance/wasmtime/blob/master/docs/WASI-api.md#__wasi_fd_write
    let nwritten = 0;
    if (fd == 1) {
      for (let iovs_i=0; iovs_i<iovs_len;iovs_i++) {
        let iov_ptr = iovs_ptr+iovs_i*8; // assuming wasm32
        let ptr = this.envMem().getUint32(iov_ptr + 0, true);
        let len = this.envMem().getUint32(iov_ptr + 4, true);
        for (let i=0; i<len; i++) {
          let c = this.envMem().getUint8(ptr+i);
          if (c == 13) { // CR
            // ignore
          } else if (c == 10) { // LF
            // write line
            let line = (new TextDecoder('utf-8')).decode(new Uint8Array(this.logLine));
            this.logLine = [];
            log(line);
          } else {
            this.logLine.push(c);
          }
        }
      }
    } else {
      console.error('invalid file descriptor:', fd);
    }
    this.envMem().setUint32(nwritten_ptr, nwritten, true);
    return 0;
  }

  // func valueGet(v ref, p string) ref
  envValueGet(retval, v_addr, p_ptr, p_len) {
    let prop = (new TextDecoder('utf-8')).decode(new DataView(this._inst.exports.memory.buffer, p_ptr, p_len));
    let value = this.envLoadValue(v_addr);
    let result = Reflect.get(value, prop);
    this.envStoreValue(retval, result);
  }

  // valuePrepareString(v ref) (ref, int)
  envValuePrepareString(ret_addr, v_addr) {
    const s = String(this.envLoadValue(v_addr));
    const str = encoder.encode(s);
    this.envStoreValue(ret_addr, str);
    setInt64(ret_addr + 8, str.length);
  }

  envLoadValue(addr) {
    const f = this.envMem().getFloat64(addr, true);
    if (f === 0) {
      return undefined;
    }
    if (!isNaN(f)) {
      return f;
    }

    const id = this.envMem().getUint32(addr, true);
    return this._values[id];
  }

  envStoreValue(addr, v) {
    const nanHead = 0x7FF80000;

    if (typeof v === "number") {
      if (isNaN(v)) {
        this.envMem().setUint32(addr + 4, nanHead, true);
        this.envMem().setUint32(addr, 0, true);
        return;
      }
      if (v === 0) {
        this.envMem().setUint32(addr + 4, nanHead, true);
        this.envMem().setUint32(addr, 1, true);
        return;
      }
      this.envMem().setFloat64(addr, v, true);
      return;
    }

    switch (v) {
      case undefined:
        this.envMem().setFloat64(addr, 0, true);
        return;
      case null:
        this.envMem().setUint32(addr + 4, nanHead, true);
        this.envMem().setUint32(addr, 2, true);
        return;
      case true:
        this.envMem().setUint32(addr + 4, nanHead, true);
        this.envMem().setUint32(addr, 3, true);
        return;
      case false:
        this.envMem().setUint32(addr + 4, nanHead, true);
        this.envMem().setUint32(addr, 4, true);
        return;
    }

    let ref = this._refs.get(v);
    if (ref === undefined) {
      ref = this._values.length;
      this._values.push(v);
      this._refs.set(v, ref);
    }
    let typeFlag = 1;
    switch (typeof v) {
      case "string":
        typeFlag = 2;
        break;
      case "symbol":
        typeFlag = 3;
        break;
      case "function":
        typeFlag = 4;
        break;
    }
    this.envMem().setUint32(addr + 4, nanHead | typeFlag, true);
    this.envMem().setUint32(addr, ref, true);
  }
}
