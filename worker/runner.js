'use strict';

// This file loads and executes some WebAssembly compiled by TinyGo.

// Warning: this event handler is kept when running in a web worker, but is
// (intentionally) overwritten when running inside VSCode.
// This is probably not the best design, but it should eventually go away anyway
// once cross origin isolation is enabled in VSCode and the runner can run in a
// separate web worker like it does on the web:
// https://github.com/microsoft/vscode-discussions/discussions/156
onmessage = (e) => {
  let msg = e.data;
  if (msg.type === 'start') {
    startRunner(msg.sourceData, postMessage);
  } else {
    console.warn('unknown runner message:', msg);
  }
};

async function startRunner(sourceData, postMessage) {
  function sendError(message) {
    console.error(message);
    postMessage({
      type: 'error',
      message: message,
    });
  }

  postMessage({
    type: 'compiling',
  });
  // Now start downloading the binary.
  let source;
  if (sourceData instanceof Uint8Array) {
    source = sourceData;
  } else {
    // Fetch (compile) the wasm file.
    try {
      source = await fetch(sourceData.url, sourceData);
    } catch (reason) {
      if (reason instanceof TypeError) {
        // Not sure why this is a TypeError, but it is.
        // It is typically a CORS failure. More information:
        // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#checking_that_the_fetch_was_successful
        sendError(`Could not request compiled WebAssembly module, probably due to a network error:\n${reason.message}`);
        return;
      }
      // Some other error.
      sendError(reason);
      return;
    }

    // Check for a valid response.
    if (!source.ok) {
      let text = `Could not request compiled WebAssembly module: HTTP error ${source.status} ${source.statusText}`;
      if (source.status === 400 && source.headers.get('Content-Type').startsWith('text/plain')) {
        let body = await source.text();
        text += ` (${body})`;
      }
      sendError(text);
      return;
    }

    // Check for a compilation error, which will be returned as a non-wasm
    // content type.
    if (source.headers.get('Content-Type') !== 'application/wasm') {
      // Probably a compile error.
      source.text().then((text) => {
        if (text === '') {
          // Not sure when this could happen, but it's a good thing to check
          // this to be sure.
          text = `Could not request compiled WebAssembly module: no response received (status: ${source.status} ${source.statusText})`;
        }
        sendError(text);
      });
      return;
    }
  }

  // Request was sent, waiting for the compile job to finish.
  postMessage({
    type: 'loading',
  });

  let runner = new Runner(postMessage);
  try {
    await runner.start(source);
  } catch (e) {
    sendError(e);
    return;
  }

  // Loaded the program, start it now.
  postMessage({
    type: 'started',
    dataBuffer: runner.dataBuffer,
  });
  try {
    runner.run();
  } catch (e) {
    if (e === runner.simulatorExit) {
      postMessage({
        type: 'exited',
        exitCode: runner.exitCode,
      })
    } else {
      sendError(e);
    }
  }
}


class Runner {
  bufferMutexIndex = 0;
  bufferSpeedIndex = 1;
  bufferPinIndex = 2;

  constructor(postMessage) {
    this.postMessage = (msg) => postMessage(msg);

    // A buffer of 256 int32 values.
    // - index 0: a mutex of sorts (actually more like a counting semaphore):
    //   every message to the schematic worker increments it, the schematic
    //   worker decrements it when completing something, and before reading any
    //   shared state the runner waits for it to reach zero.
    // - index 1: 'speed' state (0 when sleeping, 1 when running).
    // - index 2..256: pin state for pins 0..254.
    const dataBufferLength = (1 + 1 + 255) * 4;
    if (crossOriginIsolated) {
      this.dataBuffer = new SharedArrayBuffer(dataBufferLength);
    } else {
      this.dataBuffer = new ArrayBuffer(dataBufferLength);
    }
    this.int32Buffer = new Int32Array(this.dataBuffer);
    this.int32Buffer[this.bufferSpeedIndex] = 1;

    this.reinterpretBuf = new DataView(new ArrayBuffer(8));
    this.ws2812Buffers = {};
    this.simulatorExit = {}; // sentinel error value to raise when exiting
  }

  // Load response and prepare runner, but don't run any code yet.
  async start(source) {
    const SUCCESS = 0;
    const ERRNO_BADF = 8;
    const ERRNO_NOSYS = 52;
    const CLOCKID_REALTIME = 0;
    const CLOCKID_MONOTONIC = 1;
    let importObject = {
      // Subset of the WASI environment.
      // Please keep these sorted in the same order as the specification:
      // https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
      wasi_snapshot_preview1: {
        args_get: () => {
          return SUCCESS; // there are no command line arguments
        },
        args_sizes_get: (ptr_num_args, ptr_arg_sizes) => {
          // Tell the API user there are no command line arguments.
          this.envMem().setUint32(ptr_num_args, 0);
          this.envMem().setUint32(ptr_arg_sizes, 0);
          return SUCCESS;
        },
        environ_get: () => {
          return SUCCESS; // there are no environment variables
        },
        environ_sizes_get: (ptr_num_envs, ptr_env_size) => {
          // Tell the API user there are no environment variables.
          this.envMem().setUint32(ptr_num_envs, 0);
          this.envMem().setUint32(ptr_env_size, 0);
          return SUCCESS;
        },
        clock_time_get: (id, precision, retptr) => {
          this.envMem().setBigUint64(retptr, BigInt(Math.round((this.clock.now() - this._timeOrigin) * 1000_000)), true);
          return SUCCESS;
        },
        fd_close: () => {
          return ERRNO_NOSYS; // not implemented
        },
        fd_fdstat_get: () => {
          return ERRNO_NOSYS; // not implemented
        },
        fd_fdstat_set_flags: () => {
          return ERRNO_NOSYS; // not implemented
        },
        fd_prestat_get: (fd, ptr_prestat) => {
          if (fd > 2) {
            // Only stdin/stdout/stderr are opened.
            return ERRNO_BADF;
          }
          return ERRNO_NOSYS; // not implemented
        },
        fd_prestat_dir_name: () => {
          return ERRNO_NOSYS; // not implemented
        },
        fd_seek: () => {
          return ERRNO_NOSYS; // not implemented
        },
        fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
          return this.logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr);
        },
        poll_oneoff: (subscr_in, event_out, nsubscriptions, retptr) => {
          if (nsubscriptions != 1) {
            throw 'todo: poll_oneoff: multiple subscriptions';
          }
          let tag = this.envMem().getUint8(subscr_in+8);
          if (tag != 0) { // __wasi_eventtype_clock_t
            throw 'todo: poll_oneoff: not a clock event';
          }
          let clock_id = this.envMem().getUint32(subscr_in+16, true);
          let clock_timeout = this.envMem().getBigUint64(subscr_in+24, true);
          let clock_flags = this.envMem().getUint16(subscr_in+40, true);
          if (clock_id != CLOCKID_REALTIME && clock_id != CLOCKID_MONOTONIC) {
            // Use the same clock for both monotonic and realtime for now.
            throw 'todo: poll_oneoff: unknown clock ID';
          }
          if (clock_flags != 0) {
            throw 'todo: poll_oneoff: unknown clock flags';
          }
          this.flushAsyncOperations();
          // Convert from nanoseconds to milliseconds.
          let sleepTime = Number(clock_timeout) / 1000_000;
          while (sleepTime > 0) {
            // Wait as long as the execution is paused.
            if (Atomics.load(this.int32Buffer, this.bufferSpeedIndex) === 0) {
              this.clock.pause();
              Atomics.wait(this.int32Buffer, this.bufferSpeedIndex, 0);
              this.clock.start();
            }

            // Sleep normally.
            // This actually uses the timeout as a way to sleep. It may exit
            // early if the UI pauses execution (in which case we need to pause
            // the clock until execution resumes again).
            // See: https://jasonformat.com/javascript-sleep/
            if (!crossOriginIsolated) {
              throw 'WASI sleep cannot work: runner is not cross-origin isolated.';
            }
            let start = performance.now();
            Atomics.wait(this.int32Buffer, this.bufferSpeedIndex, 1, sleepTime);
            let duration = performance.now() - start;
            sleepTime -= duration;
          }
          // Trick to sleep efficiently in a web worker.
          return SUCCESS;
        },
        proc_exit: (exitcode) => {
          this.exitCode = exitcode;
          throw this.simulatorExit;
        },
        sched_yield: () => {
          return SUCCESS; // impossible to implement in JavaScript
        },
        random_get: (bufPtr, bufLen) => {
          let buf = new Uint8Array(this.envMem().buffer, bufPtr, bufLen);
          crypto.getRandomValues(buf);
          return SUCCESS;
        },
      },
      // Bare minimum GOOS=js environment, to get time.Sleep to work.
      gojs: {
        'runtime.ticks': () =>
          this.clock.now() - this._timeOrigin,
        'runtime.sleepTicks': (timeout) => {
          this.flushAsyncOperations();
          this.clock.setTimeout(this._inst.exports.go_scheduler, timeout)
        },
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
        __tinygo_gpio_set: (pin, high) => {
          this.addTask();
          this.postMessage({
            type: 'gpio-set',
            pin: pin,
            high: high ? true : false,
          })
        },
        __tinygo_gpio_get: (pin) => {
          this.waitTasks();
          let state = Atomics.load(this.int32Buffer, this.bufferPinIndex+pin);
          if (state === 1 || state === 3) { // low, pulldown
            return 0;
          } else if (state === 2 || state === 4) { // high, pullup
            return 1;
          } else if (state === 0) {
            console.warn('reading from floating pin ' + pin);
            // Return a random value, to simulate a floating input.
            // (This is not exactly accurate, but perhaps more accurate than
            // returning a fixed 'high' or 'low').
            return Math.random() < 0.5;
          } else {
            console.warn('unknown pin state:', state);
            return 0; // unknown pin state
          }
        },
        __tinygo_gpio_configure: (pin, mode) => {
          this.addTask();
          this.postMessage({
            type: 'pin-configure',
            pin: pin,
            state: {
              0: 'floating',
              1: 'low',
              2: 'pullup',
              3: 'pulldown',
            }[mode],
          })
        },
        __tinygo_spi_configure: (bus, sck, sdo, sdi) => {
          this.postMessage({
            type: 'spi-configure',
            bus: bus,
            sck: sck,
            sdo: sdo,
            sdi: sdi,
          });
        },
        __tinygo_spi_transfer: (bus, w) => {
          this.addTask();
          this.postMessage({
            type: 'spi-transfer',
            bus: bus,
            data: new Uint8Array([w]),
          });
          return Math.floor(Math.random() * 255);
        },
        __tinygo_spi_tx: (bus, wptr, wlen, rptr, rlen) => {
          this.addTask();
          let wbuf = new Uint8Array(this._inst.exports.memory.buffer, wptr, wlen);
          this.postMessage({
            type: 'spi-transfer',
            bus: bus,
            data: wbuf,
          });
          // Fill the receive buffer with random data (to simulate a floating input).
          // TODO: actually simulate the SDI pin correctly (for two-way
          // communication).
          let rbuf = new Uint8Array(this._inst.exports.memory.buffer, rptr, rlen);
          crypto.getRandomValues(rbuf);
        },
        __tinygo_ws2812_write_byte: (pinNumber, c) => {
          if (!(pinNumber in this.ws2812Buffers)) {
            this.ws2812Buffers[pinNumber] = [];
          }
          this.ws2812Buffers[pinNumber].push(c);
        },
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
    this.clock = new Clock();
    this.clock.start();
    this._timeOrigin = this.clock.now();
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

  // Called before sending a task to the schematic worker.
  addTask() {
    Atomics.add(this.int32Buffer, this.bufferMutexIndex, 1);
  }

  // Wait until the schematic worker has processed all tasks.
  waitTasks() {
    while (1) {
      let value = Atomics.load(this.int32Buffer, this.bufferMutexIndex);
      if (value === 0)
        break;
      Atomics.wait(this.int32Buffer, this.bufferMutexIndex, value);
    }
  }

  // Add some text to the terminal output.
  logWrite(fd, iovs_ptr, iovs_len, nwritten_ptr) {
    // https://github.com/bytecodealliance/wasmtime/blob/master/docs/WASI-api.md#__wasi_fd_write
    let nwritten = 0;
    let stdout = '';
    if (fd === 1 || fd === 2) {
      for (let iovs_i=0; iovs_i<iovs_len; iovs_i++) {
        let iov_ptr = iovs_ptr + iovs_i*8; // assuming wasm32
        let ptr = this.envMem().getUint32(iov_ptr + 0, true);
        let len = this.envMem().getUint32(iov_ptr + 4, true);
        nwritten += len;
        stdout += (new TextDecoder('utf-8')).decode(new DataView(this._inst.exports.memory.buffer, ptr, len));
      }
    } else {
      console.error('invalid file descriptor:', fd);
    }
    if (stdout !== '') {
      this.postMessage({type: 'stdout', data: stdout});
    }
    this.envMem().setUint32(nwritten_ptr, nwritten, true);
    return 0;
  }

  // Process async operations that should happen before sleeping.
  flushAsyncOperations() {
    // Send all WS2812 writes to the schematic worker.
    for (let pinNumber in this.ws2812Buffers) {
      this.postMessage({
        type: 'ws2812-write',
        pin: pinNumber,
        data: this.ws2812Buffers[pinNumber],
      });
      delete this.ws2812Buffers[pinNumber];
    }
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
