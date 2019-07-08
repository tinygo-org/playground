'use strict';

const API_URL = '/api'

var inputCompileTimeout = null;
const inputCompileDelay = 1000;
var runner = null;
var compileAbortController = null;
var project = null;
var db;
const defaultTarget = 'console';

// A list of source code samples used for each target. This is the default code
// set for a given configuration.
var examples = {
  hello: 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tfmt.Println("Hello, TinyGo")\n}\n',
  blinky1: 'package main\n\nimport (\n\t"machine"\n\t"time"\n)\n\nconst led = machine.LED\n\nfunc main() {\n\tprintln("Hello, TinyGo")\n\tled.Configure(machine.PinConfig{Mode: machine.PinOutput})\n\tfor {\n\t\tled.Low()\n\t\ttime.Sleep(time.Second)\n\n\t\tled.High()\n\t\ttime.Sleep(time.Second)\n\t}\n}\n',
  blinky2: 'package main\n\nimport (\n\t"machine"\n\t"time"\n)\n\nfunc main() {\n\tprintln("Hello, TinyGo")\n\tgo blink(machine.LED1, 1000 * time.Millisecond)\n\tgo blink(machine.LED2, 750 * time.Millisecond)\n\tselect {}\n}\n\nfunc blink(led machine.Pin, delay time.Duration) {\n\tled.Configure(machine.PinConfig{Mode: machine.PinOutput})\n\tfor {\n\t\tled.Low()\n\t\ttime.Sleep(delay)\n\n\t\tled.High()\n\t\ttime.Sleep(delay)\n\t}\n}\n',
  rgbled: 'package main\n\nimport (\n\t"machine"\n\t"time"\n)\n\nvar leds = []machine.Pin{machine.LED_RED, machine.LED_GREEN, machine.LED_BLUE}\n\nfunc main() {\n\tprintln("Hello, TinyGo")\n\tfor _, led := range leds {\n\t\tled.Configure(machine.PinConfig{Mode: machine.PinOutput})\n\t\tled.High()\n\t}\n\tfor {\n\t\tfor _, led := range leds {\n\t\t\tled.Low()\n\t\t\ttime.Sleep(time.Second)\n\t\t\tled.High()\n\t\t}\n\n\t}\n}\n',
};

// Compile the script and if it succeeded, display the result on the right.
function update() {
  if (compileAbortController !== null) {
    // A previous compile was in flight. Cancel it to avoid resource starvation.
    compileAbortController.abort();
  }
  let abortController = new AbortController();
  compileAbortController = abortController;
  let terminal = document.querySelector('#terminal');
  terminal.textContent = '';
  terminal.placeholder = 'Compiling...';

  updateResetButton();

  // Compile the script.
  fetch(API_URL + '/compile?target=' + project.target, {
    method: 'POST',
    body: document.querySelector('#input').value,
    signal: abortController.signal,
  }).then((response) => {
    // Good response, but the compile was not necessarily successful.
    compileAbortController = null;
    terminal.textContent = '';
    terminal.placeholder = '';
    if (response.headers.get('Content-Type') == 'application/wasm') {
      terminal.classList.remove('error');
      if (runner !== null) {
        runner.stop();
      }
      runner = new Runner(response);
    } else {
      terminal.classList.add('error');
      response.text().then((text) => {
        terminal.textContent = text;
      });
    }
  }).catch((reason) => {
    if (abortController.signal.aborted) {
      // Expected error.
      return;
    }
    // Probably a network error.
    console.error('could not compile', reason);
    terminal.textContent = reason;
    terminal.classList.add('error');
  });
}

function log(msg) {
  let textarea = document.querySelector('#terminal');
  let distanceFromBottom = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight;
  textarea.textContent += msg + '\n';
  if (distanceFromBottom < 2) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}

// Reset all saved project settings to the defaults. This currently only
// includes source code, but will include extra devices in the future.
function resetProject() {
  project.delete()
  project = new Project({
    target: project.target,
  });
  document.querySelector('#input').value = examples[project.board.config.example];
  update();
};

// setTarget updates the current target to the new target string. The new target
// state will be loaded from the database if possible.
function setTarget(newTarget) {
  if (project) {
    project.save();
  }
  if (runner !== null) {
    // A previous job is running, stop it now.
    runner.stop();
    runner = null;
  }
  loadProject(newTarget).then(() => {
    update();
    document.querySelector('#btn-flash').disabled = project.board.config.firmwareFormat === undefined;
  });
}

// Start a firmware file download. This can be used for drag-and-drop
// programming supported by many modern development boards.
function flashFirmware(e) {
  project.save();
  e.preventDefault();

  // Create a hidden form with the correct values that sends back the file with
  // the correct headers to make this a download:
  //     Content-Disposition: attachment; filename=firmware.hex
  let form = document.createElement('form');
  form.setAttribute('method', 'POST');
  form.setAttribute('action', API_URL + '/compile?target='+project.target+'&format='+project.board.config.firmwareFormat);
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

// Update the active state of the reset button. The reset button is only active
// when there are changes to the project.
function updateResetButton() {
  document.querySelector('#btn-reset').disabled = (project.created === undefined);
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
  project.markModified();

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
    project.save();
    update();
  }, inputCompileDelay);
})

document.querySelector('#btn-reset').addEventListener('click', resetProject);
document.querySelector('#btn-flash').addEventListener('click', flashFirmware);

// Load boards.json to extend the list of boards in the target dropdown.
loadBoards();

// Compile the code on load.
document.addEventListener('DOMContentLoaded', function(e) {
  // First get the database.
  let request = indexedDB.open("tinygo-playground", 1);
  request.onupgradeneeded = function(e) {
    let db = e.target.result;
    let projects = db.createObjectStore('projects', {keyPath: 'created', autoIncrement: true});
    projects.createIndex('target', 'target', {unique: false});
  };
  request.onsuccess = function(e) {
    db = e.target.result;
    db.onerror = function(e) {
      console.error('database error:', e);
    };

    // This updates the target, which will start a compilation in the
    // background.
    setTarget(defaultTarget);
  };
  request.onerror = function(e) {
    console.error('failed to open database:', e);
  };
})
