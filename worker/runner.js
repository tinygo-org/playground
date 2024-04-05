'use strict';

// This file loads and executes some WebAssembly compiled by TinyGo.

if (typeof module !== 'undefined') {
  // Running as a Node.js module.
  global.performance = {
    now() {
      const [sec, nsec] = process.hrtime();
      return sec * 1000 + nsec / 1000000;
    }
  }
}

class Runner {
  constructor(schematic, part) {
    this.schematic = schematic;
    this.part = part;
    this.reinterpretBuf = new DataView(new ArrayBuffer(8));
  }

  // Load response and prepare runner, but don't run any code yet.
  async start(source) {
    let importObject = {
      // Bare minimum syscall/js environment, to get time.Sleep to work.
      wasi_snapshot_preview1: {
        fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) =>
          this.logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr),
        random_get: (bufPtr, bufLen) => {
          let buf = new Uint8Array(this.envMem().buffer, bufPtr, bufLen);
          crypto.getRandomValues(buf);
          return 0;
        },
      },
      gojs: {
        'runtime.ticks': () =>
          this.schematic.clock.now() - this._timeOrigin,
        'runtime.sleepTicks': (timeout) =>
          this.schematic.clock.setTimeout(this._inst.exports.go_scheduler, timeout),
        'syscall/js.finalizeRef': () =>
          console.error('js.finalizeRef is not supported'),
        'syscall/js.stringVal': () =>
          console.error('js.stringVal is not supported'),
        'syscall/js.valueCall': () =>
          console.error('js.FuncOf is not supported'),
        'syscall/js.valueGet': (v_ref, p_ptr, p_len) =>
          this.envValueGet(v_ref, p_ptr, p_len),
        'syscall/js.valueIndex': () =>
          console.error('js.valueIndexis not supported'),
        'syscall/js.valueLength': () =>
          console.error('js.valueLength is not supported'),
        'syscall/js.valueLoadString': () =>
          console.error('js.valueLoadString is not supported'),
        'syscall/js.valuePrepareString': () =>
          console.error('js.valuePrepareString is not supported'),
        'syscall/js.valueSet': () =>
          console.error('js.valueSet is not supported'),
      },
      env: {
        __tinygo_gpio_set: (pin, high) =>
          this.part.getPin(pin).set(high ? true : false),
        __tinygo_gpio_get: (pin) =>
          this.part.getPin(pin).get(),
        __tinygo_gpio_configure: (pin, mode) =>
          this.part.getPin(pin).setState({
            0: 'floating',
            1: 'low',
            2: 'pullup',
            3: 'pulldown',
          }[mode]),
        __tinygo_spi_configure: (bus, sck, sdo, sdi) => {
          this.part.getSPI(bus).configureAsController(this.part.getPin(sck), this.part.getPin(sdo), this.part.getPin(sdi));
        },
        __tinygo_spi_transfer: (bus, w) => {
          return this.part.getSPI(bus).transfer(w);
        },
        __tinygo_ws2812_write_byte: (pinNumber, c) =>
          this.part.getPin(pinNumber).writeWS2812(c),
      },
    };
    let result;
    if (source instanceof Uint8Array) {
      // Running inside VS Code.
      result = await WebAssembly.instantiate(source, importObject);
    } else if ('instantiateStreaming' in WebAssembly) {
      // Running inside a modern browser.
      result = await WebAssembly.instantiateStreaming(source, importObject);
    } else {
      // Running on old version of Safari, probably.
      let bytes = await source.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, importObject);
    }
    this._timeOrigin = this.schematic.clock.now();
    this._inst = result.instance;
    this._ids = new Map();
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
      {}, // 'this' object (not exposed)
    ];
  }

  // Start running the code.
  run() {
    this._inst.exports._start();
  }

  envMem() {
    return new DataView(this._inst.exports.memory.buffer)
  }

  logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr) {
    // https://github.com/bytecodealliance/wasmtime/blob/master/docs/WASI-api.md#__wasi_fd_write
    let nwritten = 0;
    if (fd === 1) {
      for (let iovs_i=0; iovs_i<iovs_len; iovs_i++) {
        let iov_ptr = iovs_ptr + iovs_i*8; // assuming wasm32
        let ptr = this.envMem().getUint32(iov_ptr + 0, true);
        let len = this.envMem().getUint32(iov_ptr + 4, true);
        nwritten += len;
        for (let i=0; i<len; i++) {
          this.part.logBuffer.push(this.envMem().getUint8(ptr+i));
        }
      }
      this.part.notifyUpdate(); // signal that there is new text to be shown in the console
    } else {
      console.error('invalid file descriptor:', fd);
    }
    this.envMem().setUint32(nwritten_ptr, nwritten, true);
    return 0;
  }

  // func valueGet(v ref, p string) ref
  envValueGet(v_ref, p_ptr, p_len) {
    let prop = (new TextDecoder('utf-8')).decode(new DataView(this._inst.exports.memory.buffer, p_ptr, p_len));
    let value = this.unboxValue(v_ref);
    let result = Reflect.get(value, prop);
    return this.boxValue(result);
  }

  unboxValue(v_ref) {
    this.reinterpretBuf.setBigInt64(0, v_ref, true);
    const f = this.reinterpretBuf.getFloat64(0, true);
    if (f === 0) {
      return undefined;
    }
    if (!isNaN(f)) {
      return f;
    }
    const id = v_ref & 0xffffffffn;
    return this._values[id];
  }

  boxValue(v) {
    const nanHead = 0x7FF80000n;

    if (typeof v === "number") {
      if (isNaN(v)) {
        return nanHead << 32n;
      }
      if (v === 0) {
        return (nanHead << 32n) | 1n;
      }
      this.reinterpretBuf.setFloat64(0, v, true);
      return this.reinterpretBuf.getBigInt64(0, true);
    }

    switch (v) {
      case undefined:
        return 0n;
      case null:
        return (nanHead << 32n) | 2n;
      case true:
        return (nanHead << 32n) | 3n;
      case false:
        return (nanHead << 32n) | 4n;
    }

    let ref = this._ids.get(v);
    if (ref === undefined) {
      ref = BigInt(this._values.length);
      this._values.push(v);
      this._ids.set(v, ref);
    }
    let typeFlag = 1n;
    switch (typeof v) {
      case "string":
        typeFlag = 2n;
        break;
      case "symbol":
        typeFlag = 3n;
        break;
      case "function":
        typeFlag = 4n;
        break;
    }
    this.envMem().setUint32(addr + 4, nanHead | typeFlag, true);
    this.envMem().setUint32(addr, ref, true);
  }
}
