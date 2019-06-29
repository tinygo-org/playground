'use strict';

var inputCompileTimeout = null;
const inputCompileDelay = 500;
var runner = null;
var compileAbortController = null;
var board = null;

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

  if (board === null || board.name !== getTarget()) {
    // No board or a different board was selected.
    if (runner !== null) {
      // A previous job is running, stop it now.
      runner.stop();
      runner = null;
    }
    board = new Board(boards[getTarget()], document.querySelector('#devices'))
  }

  // Compile the script.
  fetch('/api/compile?target=' + getTarget(), {
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

function getTarget() {
  return document.querySelector('#target').value;
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

// Compile the code on load.
document.addEventListener('DOMContentLoaded', function(e) {
  update();
})

// Compile the code when the target has changed.
document.querySelector('#target').addEventListener('change', () => update());

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
    update();
  }, inputCompileDelay);
})
