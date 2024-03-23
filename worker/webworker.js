'use strict';

if (typeof Schematic === 'undefined') {
  // Running inside a web browser, so we need to import these scripts.
  // They are concatenated together in VSCode so we don't need to import them
  // manually there.
  importScripts(
    'parts.js',
    'runner.js',
    'wiring.js',
  );
}
onmessage = (e) => handleIncomingMessage(e.data);

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
  } else if (message.type === 'input') {
    schematic.getPart(message.id).handleInput(message);
  } else {
    console.log('unknown message:', message);
  }
}

// Start download/initialize/run of the program to run and initialize the
// schematic.
async function start(msg) {
  let source;
  if (msg.binary instanceof Uint8Array) {
    source = msg.binary;
  } else {
    // Fetch (compile) the wasm file.
    try {
      source = await fetch(msg.binary.url, msg.binary);
    } catch (reason) {
      if (reason instanceof TypeError) {
        // Not sure why this is a TypeError, but it is.
        // It is typically a CORS failure. More information:
        // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#checking_that_the_fetch_was_successful
        sendError(`Could not request compiled WebAssembly module, probably due to a network error:\n${reason.message}`).
        return;
      }
      // Some other error.
      sendError(reason);
      return;
    }

    // Check for a valid response.
    if (!source.ok) {
      sendError(`Could not request compiled WebAssembly module: HTTP error ${source.status} ${source.statusText}`);
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

  // The program is compiled, but not yet fully downloaded. Set up all the
  // electronics for this program in preparation of running it.
  schematic = new Schematic(sendConnections, () => {
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

// sendConnections sends the current netlist to the UI so that the UI can show
// which pins are connected together.
function sendConnections(nets) {
  let connections = [];
  for (let net of Object.values(nets)) {
    let pinIds = [];
    for (let pin of net.pins) {
      pinIds.push(pin.id);
    }
    connections.push(pinIds);
  }
  postMessage({
    type: 'connections',
    pinLists: connections,
  });
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
