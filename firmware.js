'use strict';

class Firmware {
  constructor(url) {
    this.url = url;
    this.logLine = [];
    let wasmPromise = fetch(url).then((response) => {
      if (!response.ok) {
        if (response.status == 404) {
          throw Error('file not found: ' + url);
        } else if (response.statusText) {
          throw Error(response.statusText);
        } else {
          throw Error('error ' + response.status + ': ' + url);
        }
      }
      return response;
    }).catch((e) =>{
      log(e);
      throw e;
    });
    WebAssembly.instantiateStreaming(wasmPromise, {
      // Bare minimum syscall/js environment, to get time.Sleep to work.
      env: {
        io_get_stdout: () => 0,
        resource_write: (fd, ptr, len) => this.logWrite(fd, ptr, len),
        'runtime.ticks': () =>
          performance.now() - this._timeOrigin,
        'syscall/js.valueGet': (retval, v_addr, p_ptr, p_len) =>
          this.envValueGet(retval, v_addr, p_ptr, p_len),
        'syscall/js.valuePrepareString': (ret_addr, v_addr) =>
          this.envValuePrepareString(ret_addr, v_addr),
        'syscall/js.valueLoadString': (v_addr, slice_ptr, slice_len, slice_cap) =>
          this.envValueLoadString(v_addr, slice_ptr, slice_len, slice_cap),
        'runtime.sleepTicks': (timeout) =>
          setTimeout(this._inst.exports.go_scheduler, timeout),
        boardsimu_gpio_set: (pin, high) =>
          board.getPin(pin).set(high ? true : false),
        boardsimu_gpio_configure: (pin, mode) =>
          board.getPin(pin).setMode({
            0: 'input',
            1: 'output',
          }[mode]),
      },
    })
    .then(this.onload.bind(this))
    .catch((err) => log(err));
  }

  onload(result) {
    log('loaded ' + this.url);
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
    this._inst.exports.cwa_main();
  }

  envMem() {
    return new DataView(this._inst.exports.memory.buffer)
  }

  logWrite(fd, ptr, len) {
    if (fd == 0) {
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
    let typeFlag = 0;
    switch (typeof v) {
      case "string":
        typeFlag = 1;
        break;
      case "symbol":
        typeFlag = 2;
        break;
      case "function":
        typeFlag = 3;
        break;
    }
    this.envMem().setUint32(addr + 4, nanHead | typeFlag, true);
    this.envMem().setUint32(addr, ref, true);
  }
}

function log(msg) {
  let textarea = document.querySelector('#terminal');
  let distanceFromBottom = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight;
  textarea.textContent += msg + '\n';
  if (distanceFromBottom < 2) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}

let firmware = new Firmware('firmware.wasm');
