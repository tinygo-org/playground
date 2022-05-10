'use strict';

if (typeof module === 'undefined') {
  // Running in a browser, not in VS Code.
  importScripts(
    'parts.js',
    'runner.js',
    'wiring.js',
  );
  onmessage = (e) => handleIncomingMessage(e.data);
} else {
  // Running in a Node.js (VS Code) worker.
  const { parentPort } = require('worker_threads');
  var postMessage = function(message) {
    parentPort.postMessage(message);
  }
  let runner = require('./runner.js');
  let wiring = require('./wiring.js');
  global.Runner = runner.Runner;
  global.Schematic = wiring.Schematic;
  parentPort.addListener('message', handleIncomingMessage);
}

let schematic = null;

function handleIncomingMessage(message) {
  if (message.type === 'start') {
    start(message);
  } else if (message.type === 'getUpdate') {
    // Received when the UI thread has received a requestAnimationFrame event.
    // Send all updates received since the last getUpdate message.
    postMessage({
      type: 'update',
      updates: schematic.getUpdates(),
    });
  } else if (message.type === 'add') {
    let hasProperties = false;
    for (let part of message.parts || []) {
      let instance = schematic.addPart(part);
      if (instance.properties) {
        hasProperties = true;
      }
    }
    for (let wire of message.wires || []) {
      schematic.addWire(wire.from, wire.to);
    }
    if (hasProperties) {
      // Update properties pane.
      postMessage({
        type: 'properties',
        properties: schematic.getPropertyTypes(),
      });
      // Send new properties.
      for (let part of Object.values(schematic.parts)) {
        if (part.properties) {
          part.notifyUpdate();
        }
      }
    }
    schematic.updateNets();
  } else if (message.type === 'remove') {
    let hasProperties = false;
    for (let id of message.parts || []) {
      if (schematic.parts[id].properties) {
        hasProperties = true;
      }
      schematic.removePart(id);
    }
    for (let wire of message.wires || []) {
      schematic.removeWire(wire.from, wire.to);
    }
    if (hasProperties) {
      // Update properties pane.
      postMessage({
        type: 'properties',
        properties: schematic.getPropertyTypes(),
      });
      // Send new properties.
      for (let part of Object.values(schematic.parts)) {
        if (part.properties) {
          part.notifyUpdate();
        }
      }
    }
    schematic.updateNets();
  } else if (message.type === 'playpause') {
    if (schematic.clock.running) {
      schematic.clock.pause();
    } else {
      schematic.clock.start(); // restart from where it was paused
    }
    postMessage({
      type: 'speed',
      speed: schematic.clock.running ? 1 : 0,
    });
  } else {
    console.log('unknown message:', message);
  }
}

// Start download/initialize/run of the program to run and initialize the
// schematic.
async function start(msg) {
  let source;
  if (msg.binary) {
    source = msg.binary;
  } else {
    // Fetch (compile) the wasm file.
    try {
      source = await fetch(msg.fetch.url, msg.fetch);
    } catch (reason) {
      // Probably a network error.
      sendError(reason);
      return;
    }

    // Check for a compilation error, which will be returned as a non-wasm
    // content type.
    if (source.headers.get('Content-Type') !== 'application/wasm') {
      // Probably a compile error.
      source.text().then((text) => {
        sendError(text);
      });
      return;
    }
  }

  // The program is compiled, but not yet fully downloaded. Set up all the
  // electronics for this program in preparation of running it.
  schematic = new Schematic(() => {
    postMessage({
      type: 'notifyUpdate',
    });
  });
  for (let part of msg.config.parts) {
    schematic.addPart(part);
  }
  for (let wire of msg.config.wires) {
    schematic.addWire(wire.from, wire.to);
  }
  schematic.updateNets();
  postMessage({
    type: 'properties',
    properties: schematic.getPropertyTypes(),
  });
  schematic.notifyUpdate();

  // Do a streaming load of the WebAssembly code.
  // This will also result in the UI requesting the first update.
  postMessage({
    type: 'loading',
  });
  let runner = new Runner(schematic, schematic.getPart(msg.config.mainPart));
  try {
    await runner.start(source);
  } catch (e) {
    sendError(e);
    return;
  }

  // Loaded the program, start it now.
  postMessage({
    type: 'started',
  });
  runner.run();
}

// sendError sends an error back to the UI thread, which will display it and
// likely kill this web worker.
function sendError(message) {
  console.error(message);
  postMessage({
    type: 'error',
    message: message,
  });
}
