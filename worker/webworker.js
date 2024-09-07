'use strict';

if (typeof Schematic === 'undefined') {
  // Running inside a web browser, so we need to import these scripts.
  // They are concatenated together in VSCode so we don't need to import them
  // manually there.
  importScripts(
    'parts.js',
    'wiring.js',
  );
}
onmessage = (e) => handleIncomingMessage(e.data);

let schematic = null;
let mainPart = null;

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
    let hasPower = false;
    for (let part of message.parts || []) {
      let instance = schematic.addPart(part);
      if (instance.properties) {
        hasProperties = true;
      }
      if (instance.power) {
        hasPower = true;
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
    if (hasPower) {
      // Update power pane.
      postMessage({
        type: 'power',
        powerTree: schematic.getPowerTree(),
      });
      // Send new power consumption values.
      for (let part of Object.values(schematic.parts)) {
        if (part.power) {
          part.notifyUpdate();
        }
      }
    }
    schematic.updateNets();
  } else if (message.type === 'remove') {
    let hasProperties = false;
    let hasPower = false;
    for (let id of message.parts || []) {
      let part = schematic.parts[id];
      if (part.properties) {
        hasProperties = true;
      }
      if (part.power) {
        hasPower = true;
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
    if (hasPower) {
      // Update power pane.
      postMessage({
        type: 'power',
        powerTree: schematic.getPowerTree(),
      });
      // Send new power consumption values.
      for (let part of Object.values(schematic.parts)) {
        if (part.power) {
          part.notifyUpdate();
        }
      }
    }
    schematic.updateNets();
  } else if (message.type === 'playpause') {
    let running = mainPart.playpause();
    postMessage({
      type: 'speed',
      speed: running ? 1 : 0,
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
  // Set up all the electronics for this program in preparation of running it.
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
  postMessage({
    type: 'power',
    powerTree: schematic.getPowerTree(),
  });
  schematic.notifyUpdate();

  // Now run the binary inside the MCU part.
  mainPart = schematic.getPart(msg.config.mainPart);
  await mainPart.start(msg.binary, msg.runnerURL);
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
