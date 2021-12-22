'use strict';

// This file controls the entire playground window, except for the output part
// on the right that is shared with the VS Code extension.

const API_URL = location.hostname == 'localhost' ? '/api' : 'https://playground-bttoqog3vq-uc.a.run.app/api';

var inputCompileTimeout = null;
const inputCompileDelay = 1000;
var worker = null;
var workerUpdate = null;
var project = null;
var db = null;
var schematic = null;
const defaultProjectName = 'console';

// A list of source code samples used for each target. This is the default code
// set for a given configuration.
var examples = {
  hello: 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tfmt.Println("Hello, TinyGo")\n}\n',
  blinky1: 'package main\n\nimport (\n\t"machine"\n\t"time"\n)\n\nconst led = machine.LED\n\nfunc main() {\n\tprintln("Hello, TinyGo")\n\tled.Configure(machine.PinConfig{Mode: machine.PinOutput})\n\tfor {\n\t\tled.Low()\n\t\ttime.Sleep(time.Second)\n\n\t\tled.High()\n\t\ttime.Sleep(time.Second)\n\t}\n}\n',
  rgbled: 'package main\n\nimport (\n\t"machine"\n\t"time"\n)\n\nvar leds = []machine.Pin{machine.LED_RED, machine.LED_GREEN, machine.LED_BLUE}\n\nfunc main() {\n\tprintln("Hello, TinyGo")\n\tfor _, led := range leds {\n\t\tled.Configure(machine.PinConfig{Mode: machine.PinOutput})\n\t\tled.High()\n\t}\n\tfor {\n\t\tfor _, led := range leds {\n\t\t\tled.Low()\n\t\t\ttime.Sleep(time.Second)\n\t\t\tled.High()\n\t\t}\n\n\t}\n}\n',
};

// List of boards to show in the menu. See parts/*.json.
var boardNames = {
  'console': 'Console',
  'arduino': 'Arduino Uno',
  'arduino-nano33': 'Arduino Nano 33 IoT',
  'circuitplay-express': 'Circuit Playground Express',
  'hifive1b': 'HiFive1 rev B',
  'reelboard': 'Phytec reel board',
  'pinetime-devkit0': 'PineTime (dev kit)',
};

// Compile the script and if it succeeded, display the result on the right.
async function update() {
  // Reset terminal to the begin 'compiling' state.
  terminal.clear('Compiling...');

  // Stop program and make the schematic gray.
  stopWorker();
  document.querySelector('#schematic').classList.add('compiling');

  // Load the UI: download the SVG file and initialize parts.
  schematic = new Schematic(project.data);
  await schematic.refresh();

  // Run the script in a web worker.
  let message = {
    type: 'start',
    fetch: {
      url: API_URL + '/compile?target=' + project.target,
      method: 'POST',
      body: document.querySelector('#input').value,
    },
    config: schematic.configForWorker(),
  };
  worker = new Worker('worker/webworker.js');
  worker.postMessage(message);
  worker.onmessage = async function(e) {
    let worker = e.target; // make sure we use the correct worker (it might have changed after a call to update())
    let msg = e.data;
    if (msg.type == 'error') {
      // There was an error. Terminate the worker, it has no more work to do.
      stopWorker();
      terminal.showError(msg.message);
    } else if (msg.type == 'loading') {
      // Code was compiled and response wasm is streaming in.
      terminal.clear('Loading...');

      // Request an update.
      worker.postMessage({
        type: 'getUpdate',
      });
    } else if (msg.type == 'started') {
      // WebAssembly code was loaded and will start now.
      document.querySelector('#schematic').classList.remove('compiling');
      terminal.clear('Running...');
    } else if (msg.type == 'notifyUpdate') {
      // The web worker is signalling that there are updates.
      // It won't repeat this message until the updates have been read using
      // getUpdate.
      // Request the updates in a requestAnimationFrame: this makes sure
      // updates are only pushed when needed.
      workerUpdate = requestAnimationFrame(() => {
        workerUpdate = null;
        // Now request these updates.
        worker.postMessage({
          type: 'getUpdate',
        });
      });
    } else if (msg.type === 'properties') {
      // Set properties in the properties panel at the bottom.
      schematic.addProperties(msg.properties);
    } else if (msg.type == 'update') {
      // Received updates (such as LED state changes) from the web worker after
      // a getUpdate message.
      // Update the UI with the new state.
      schematic.update(msg.updates);
    } else {
      // Unknown message.
      console.log('unknown worker message:', msg);
    }
  };
}

// Terminate the worker immediately.
function stopWorker() {
  if (worker === null)
    return;
  worker.terminate();
  worker = null;
  if (workerUpdate !== null) {
    cancelAnimationFrame(workerUpdate);
    workerUpdate = null;
  }
}

// updateBoards updates the dropdown menu. This must be done after loading the
// boards or updating the target selection.
async function updateBoards() {
  if (project) {
    let button = document.querySelector('#target > button');
    if (project.data.humanName) {
      button.textContent = project.data.humanName + ' ';
    } else if (project.data.created) {
      button.textContent = project.data.defaultHumanName + ' * ';
    } else {
      button.textContent = project.data.defaultHumanName + ' ';
    }
  }

  let projects = await getProjects();

  let dropdown = document.querySelector('#target > .dropdown-menu');
  dropdown.innerHTML = '';
  for (let [name, humanName] of Object.entries(boardNames)) {
    let item = document.createElement('a');
    item.textContent = humanName;
    item.classList.add('dropdown-item');
    if (project && name == project.name) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = name;
    dropdown.appendChild(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      setProject(item.dataset.name);
    });
  }

  if (!projects.length) {
    // No saved projects.
    return;
  }

  let divider = document.createElement('div');
  divider.classList.add('dropdown-divider');
  dropdown.appendChild(divider);

  // Add a list of projects (modified templates).
  for (let projectObj of projects) {
    let item = document.createElement('a');
    item.innerHTML = '<span class="text"><span class="name"></span> – <i class="time"></i></span><span class="buttons"><button class="btn btn-light btn-sm edit-symbol rename" title="Rename">✎</button> <button class="btn btn-light btn-sm delete" title="Delete">🗑</button></span>';
    if (projectObj.humanName) {
      item.querySelector('.text').textContent = projectObj.humanName;
    } else {
      item.querySelector('.name').textContent = projectObj.defaultHumanName;
      item.querySelector('.time').textContent = projectObj.created.toISOString();
    }
    item.classList.add('dropdown-item');
    item.classList.add('project-name');
    if (project && projectObj.name == project.name) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = projectObj.name;
    dropdown.appendChild(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      setProject(item.dataset.name);
    });

    item.querySelector('.rename').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      let name = e.target.parentNode.parentNode.dataset.name;
      let humanName = prompt('Project name', project.data.humanName || project.config.humanName);
      if (!humanName) {
        return; // clicked 'cancel'
      }

      if (project.name == name) {
        // Update name of current project.
        project.data.humanName = humanName;
      }
      let tx = db.transaction(['projects'], 'readwrite');
      tx.objectStore('projects').get(name).onsuccess = function(e) {
        let obj = e.target.result;
        obj.humanName = humanName;
        tx.objectStore('projects').put(obj).onsuccess = function(e) {
          updateBoards();
        };
      };
    });

    item.querySelector('.delete').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      let name = e.target.parentNode.parentNode.dataset.name;
      if (name == project.name) {
        setProject(project.target);
      }
      db.transaction(['projects'], 'readwrite').objectStore('projects').delete(name);
      updateBoards();
    });
  }
}

// setProject updates the current project to the new project name.
async function setProject(name) {
  if (project && project.data.created) {
    project.save(document.querySelector('#input').value);
  }
  if (worker !== null) {
    // A previous job is running, stop it now.
    stopWorker();
  }
  project = await loadProject(name);
  updateBoards();
  let input = document.querySelector('#input');
  input.value = project.data.code;
  input.disabled = false;
  update();
  localStorage.tinygo_playground_projectName = name;
  document.querySelector('#btn-flash').disabled = project.config.firmwareFormat === undefined;
}

// Start a firmware file download. This can be used for drag-and-drop
// programming supported by many modern development boards.
function flashFirmware(e) {
  project.save(document.querySelector('#input').value);
  e.preventDefault();

  // Create a hidden form with the correct values that sends back the file with
  // the correct headers to make this a download:
  //     Content-Disposition: attachment; filename=firmware.hex
  let form = document.createElement('form');
  form.setAttribute('method', 'POST');
  form.setAttribute('action', API_URL + '/compile?target='+project.target+'&format='+project.config.firmwareFormat);
  form.classList.add('d-none');
  let input = document.createElement('input');
  input.setAttribute('type', 'hidden');
  input.setAttribute('name', 'code');
  input.value = document.querySelector('#input').value;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

// Save the current project.
function saveState() {
  project.save();
}

function workerPostMessage(message) {
  worker.postMessage(message);
}

// Source:
// https://www.everythingfrontend.com/posts/insert-text-into-textarea-at-cursor-position.html
function insertAtCursor (input, textToInsert) {
  const couldInsert = document.execCommand("insertText", false, textToInsert);

  // Firefox (non-standard method)
  if (!couldInsert && typeof input.setRangeText === "function") {
    const start = input.selectionStart;
    input.setRangeText(textToInsert);
    // update cursor to be at the end of insertion
    input.selectionStart = input.selectionEnd = start + textToInsert.length;

    // Notify any possible listeners of the change
    const e = document.createEvent("UIEvent");
    e.initEvent("input", true, false);
    input.dispatchEvent(e);
  }
}

document.querySelector('#input').addEventListener('input', function(e) {
  // Insert whitespace at the start of the next line.
  if (e.inputType == 'insertLineBreak') {
    let line = e.target.value.substr(0, e.target.selectionStart).trimRight();
    if (line.lastIndexOf('\n') >= 0) {
      line = line.substr(line.lastIndexOf('\n')+1);
    }

    // Get the number of tabs at the start of the previous line.
    let numTabs = 0;
    for (let i=0; i<line.length; i++) {
      if (line.substr(i, 1) != '\t') {
        break;
      }
      numTabs++;
    }

    // Increase the number of tabs if this is the start of a block.
    if (line.substr(-1, 1) == '{' || line.substr(-1, 1) == '(') {
      numTabs += 1;
    }

    // Insert the number of tabs at the current cursor location, which must be
    // the start of the next line.
    let insertBefore = '';
    for (let i=0; i<numTabs; i++) {
      insertBefore += '\t';
    }
    insertAtCursor(input, insertBefore);
  }

  // Compile the code after a certain delay of inactivity.
  if (inputCompileTimeout !== null) {
    clearTimeout(inputCompileTimeout);
  }
  inputCompileTimeout = setTimeout(() => {
    project.save(document.querySelector('#input').value);
    localStorage.tinygo_playground_projectName = project.name;
    update();
  }, inputCompileDelay);
})

document.querySelector('#btn-flash').addEventListener('click', flashFirmware);

// loadDB loads the playground database asynchronously. It returns a promise
// that resolves when the database is loaded.
function loadDB() {
  return new Promise((resolve, reject) => {
    // First get the database.
    let request = indexedDB.open("tinygo-playground", 2);
    request.onupgradeneeded = function(e) {
      let db = e.target.result;
      if (e.oldVersion == 1) {
        // The proper way would be to upgrade the object store in place, but the
        // easy way is to simply drop all existing data.
        db.deleteObjectStore('projects');
      }
      let projects = db.createObjectStore('projects', {keyPath: 'name', autoIncrement: true});
      projects.createIndex('target', 'target', {unique: false});
    };
    request.onsuccess = function(e) {
      resolve(e.target.result);
    };
    request.onerror = function(e) {
      reject(e);
    };
  })
}

// Initialize the playground.
document.addEventListener('DOMContentLoaded', async function(e) {
  // Start loading everything.
  let dbPromise = loadDB();

  // Wait for everything to complete loading.
  db = await dbPromise;
  db.onerror = function(e) {
    console.error('database error:', e);
  };

  // Update the drop down list of boards and projects.
  updateBoards();

  // Load the current default project.
  // This updates the target, which will start a compilation in the background.
  setProject(localStorage.tinygo_playground_projectName || defaultProjectName);
})
