'use strict';

importScripts(
  'runner.js',
  'wiring.js',
  'parts.js',
);

let schematic = null;

onmessage = function(e) {
  if (e.data.type === 'start') {
    start(e.data);
  } else if (e.data.type === 'getUpdate') {
    // Received when the UI thread has received a requestAnimationFrame event.
    // Send all updates received since the last getUpdate message.
    postMessage({
      type: 'update',
      updates: schematic.getUpdates(),
    });
  } else {
    console.log('unknown message:', e.data);
  }
}

// Start download/initialize/run of the program to run and initialize the
// schematic.
async function start(msg) {
  // Fetch (compile) the wasm file.
  let response;
  try {
    response = await fetch(msg.fetch.url, msg.fetch);
  } catch (reason) {
    // Probably a network error.
    sendError(reason);
    return;
  }

  // The program is compiled, but not yet fully downloaded. Set up all the
  // electronics for this program in preparation of running it.
  schematic = new Schematic();
  for (let part of msg.parts || []) {
    part.id = msg.id + '.' + part.id;
    schematic.addPart(part);
  }
  for (let wire of msg.wires || []) {
    schematic.addWire(msg.id + '.' + wire.from, msg.id + '.' + wire.to);
  }
  schematic.updateNets();
  schematic.notifyUpdate();

  // Check for a compilation error, which will be returned as a non-wasm
  // content type.
  if (response.headers.get('Content-Type') !== 'application/wasm') {
    // Probably a compile error.
    response.text().then((text) => {
      sendError(text);
    });
    return;
  }

  // Do a streaming load of the WebAssembly code.
  postMessage({
    type: 'loading',
  });
  let runner = new Runner(schematic, schematic.getPart(msg.id + '.' + msg.mainPart));
  try {
    await runner.start(response);
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
