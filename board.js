'use strict';

// This file emulates a hardware board with an MCU and a set of external
// devices (LEDs etc.).


// List of boards to show in the menu. See parts/*.json.
var boardNames = {
  'console': 'Console',
  'arduino': 'Arduino Uno',
  'arduino-nano33': 'Arduino Nano 33 IoT',
  'circuitplay-express': 'Circuit Playground Express',
  'hifive1b': 'HiFive1 rev B',
  'reelboard': 'Phytec reel board',
  'pinetime-devkit0': 'PineTime (dev kit)',
}

// The number of CSS pixels in a CSS millimeter. Yes, this is a constant,
// defined by the CSS specification. This doesn't correspond exactly to
// real-world pixels and millimeters, but millimeters should be pretty close.
// For more information:
// https://developer.mozilla.org/en-US/docs/Learn/CSS/Building_blocks/Values_and_units
const pixelsPerMillimeter = 96 / 25.4;

// refreshParts redraws all the SVG parts from scratch
async function refreshParts(parts) {
  // Load all SVG elements in parallel.
  let promises = [];
  for (let part of Object.values(parts)) {
    if (part.config.svg) {
      promises.push(part.loadSVG());
    }
  }

  // Wait until they are loaded.
  await Promise.all(promises);

  // Remove existing SVG elements.
  let partsGroup = document.querySelector('#schematic-parts');
  for (let child of partsGroup.children) {
    child.remove();
  }

  // Put SVGs in the schematic.
  let partHeights = [];
  let schematic = document.querySelector('#schematic');
  for (let part of Object.values(parts)) {
    if (part.svg) {
      partsGroup.appendChild(part.createElement(schematic));

      // Store the height, to calculate the minimum height of the schematic.
      // Add a spacing of 20px so that the board has a bit of spacing around it.
      partHeights.push('calc(' + part.height + ' + 20px)');
    }
  }

  // Set the height of the schematic.
  schematic.classList.toggle('d-none', partHeights.length === 0);
  if (partHeights.length) {
    schematic.style.height = 'max(' + partHeights.join(', ') + ')';
  }

  // Workaround for Chrome positioning bug and Firefox rendering bug.
  fixPartsLocation();
}

// Create a 'config' struct with a flattened view of the schematic, to be sent
// to the worker.
function configForWorker(parts) {
  let config = {
    parts: [],
    wires: [],
  };
  for (let [id, part] of Object.entries(parts)) {
    if (id === 'main') {
      config.mainPart = 'main.' + part.config.mainPart;
    }
    for (let subpart of part.config.parts) {
      let obj = Object.assign({}, subpart, {id: id + '.' + subpart.id});
      config.parts.push(obj);
    }
    for (let wire of part.config.wires || []) {
      config.wires.push({
        from: id + '.' + wire.from,
        to: id + '.' + wire.to,
      });
    }
  }
  return config;
}

// updatePart updates a (sub)part in the UI with the given updates coming from
// the web worker that's running the simulated program.
function updateParts(parts, updates) {
  for (let update of updates) {
    let partId = update.id.split('.', 1)[0];
    let part = parts[partId].subparts[update.id];

    // LED strips, like typical WS2812 strips.
    if (update.ledstrip) {
      for (let i=0; i<part.leds.length; i++) {
        let properties = update.ledstrip[i];
        part.leds[i].style.setProperty('--color', properties.color);
        part.leds[i].style.setProperty('--shadow', properties.shadow);
      }
    }

    // Displays of various sorts that render to a canvas element.
    if (update.canvas) {
      // TODO: do the createImageBitmap in the web worker.
      createImageBitmap(update.canvas).then(bitmap => {
        part.context.drawImage(bitmap, 0, 0);
        bitmap.close();
      });
    }

    // Simple devices (like LEDs) that only need to change some CSS properties.
    for (let [key, value] of Object.entries(update.cssProperties || {})) {
      part.container.style.setProperty('--' + key, value);
    }

    // Main MCU that prints some text.
    if (update.logText) {
      log(update.logText);
    }
  }
}

// getProjects returns the complete list of project objects from the projects
// store.
async function getProjects() {
  // Load all projects.
  let projects = [];
  return await new Promise(function(resolve, reject) {
    db.transaction(['projects'], 'readonly').objectStore('projects').openCursor().onsuccess = function(e) {
      var cursor = e.target.result;
      if (cursor) {
        projects.push(cursor.value);
        cursor.continue();
      } else {
        resolve(projects);
      }
    }
  });
}

// updateBoards updates the dropdown menu. This must be done after loading the
// boards or updating the target selection.
async function updateBoards() {
  if (project) {
    let button = document.querySelector('#target > button');
    if (project.humanName) {
      button.textContent = project.humanName + ' ';
    } else if (project.created) {
      button.textContent = project.config.humanName + ' * ';
    } else {
      button.textContent = project.config.humanName + ' ';
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
      let humanName = prompt('Project name', project.humanName || project.config.humanName);
      if (!humanName) {
        return; // clicked 'cancel'
      }

      if (project.name == name) {
        // Update name of current project.
        project.humanName = humanName;
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

// Change the terminal to show the given error message, in red.
function showErrorInTerminal(message) {
  let textarea = document.querySelector('#terminal');
  textarea.placeholder = '';
  textarea.value = message;
  terminal.classList.add('error');
}

// clearTerminal clears any existing content from the terminal (including a
// possible error message) and sets the given placeholder.
function clearTerminal(placeholder) {
  let textarea = document.querySelector('#terminal');
  textarea.placeholder = placeholder;
  textarea.value = '';
  terminal.classList.remove('error');
}

// log writes the given message to the terminal. Note that it doesn't append a
// newline at the end.
function log(msg) {
  let textarea = document.querySelector('#terminal');
  let distanceFromBottom = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight;
  textarea.value += msg;
  if (distanceFromBottom < 2) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}

// Load all parts of the given project configuration.
async function loadParts(datas) {
  let promises = [];
  // Load all the parts in parallel!
  for (let [id, data] of Object.entries(datas)) {
    promises.push(Part.load(id, data));
  }
  let parts = await Promise.all(promises);
  let result = {};
  for (let part of parts) {
    result[part.id] = part;
  }
  return result;
}

// One independent part in the schematic. This might be a separate part like a
// LED, or it might be a board that itself also contains parts. Parts on a board
// are represented differently, though.
class Part {
  constructor(id, config, data) {
    this.id = id;
    this.config = config;
    this.data = data;
    this.subparts = {};
  }

  // Load the given part and return it (because constructor() can't be async).
  static async load(id, data) {
    let response = await fetch(data.location);
    let config = await response.json();
    return new Part(id, config, data);
  }

  // loadSVG loads the 'svg' property (this.svg) of this object.
  async loadSVG() {
    return new Promise((resolve, reject) => {
      // Determine the SVG URL, which is relative to the board config JSON file.
      let svgUrl = new URL(this.config.svg, new URL('parts/', document.baseURI));

      // Load the SVG file.
      // Doing this with XHR because XHR allows setting responseType while the
      // newer fetch API doesn't.
      let xhr = new XMLHttpRequest();
      xhr.open('GET', svgUrl);
      xhr.responseType = 'document';
      xhr.send();
      xhr.onload = (() => {
        this.svg = xhr.response.rootElement;
        this.width = this.svg.getAttribute('width');
        this.height = this.svg.getAttribute('height');
        resolve();
      }).bind(this);
    });
  }

  // Create the wrapper for the part SVG and initialize it.
  createElement(schematic) {
    this.wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.wrapper.setAttribute('class', 'board-wrapper');

    // Add SVG to the schematic at the correct location.
    this.wrapper.appendChild(this.svg);
    this.updatePosition();
    this.makeDraggable(schematic);

    // Detect parts inside the SVG file. They have a tag like
    // data-part="led".
    this.subparts = {};
    for (let el of this.svg.querySelectorAll('[data-part]')) {
      let subpart = {
        id: this.id+'.'+el.dataset.part,
        container: el,
        leds: el.querySelectorAll('[data-type="rgbled"]'),
      };
      if (el.nodeName === 'CANVAS') {
        subpart.context = el.getContext('2d');
      }
      this.subparts[subpart.id] = subpart;
    }

    return this.wrapper;
  }

  // Set a new (x, y) position in pixels, relative to the center.
  // The position is stored as millimeters, not as pixels.
  setPosition(x, y) {
    this.data.x = x / pixelsPerMillimeter;
    this.data.y = y / pixelsPerMillimeter;
    this.updatePosition();
  }

  // Update position according to this.data.x and this.data.y.
  updatePosition() {
    // Set part position relative to the center of the schematic.
    // Do this using calc() so that it stays at the correct position when
    // resizing the window.
    let x = 'calc(' + this.data.x + 'mm - ' + this.width + ' / 2)';
    let y = 'calc(' + this.data.y + 'mm - ' + this.height + ' / 2)';
    this.wrapper.style.transform = 'translate(' + x + ', ' + y + ')';
  }

  // makeDraggable is part of the setup of adding a new part to the schematic.
  // This method makes the part draggable with a mouse.
  makeDraggable(schematic) {
    this.wrapper.ondragstart = e => false;
    this.wrapper.onmousedown = function(e) {
      // Calculate as many things as possible in advance, so that the mousemove
      // event doesn't have to do much.
      // This code handles the following cases:
      //   * Don't let parts be moved outside the available space.
      //   * ...except if the available space is smaller than the part, in which
      //     case it makes more sense to limit movement to stay entirely within
      //     the available space.
      let schematicRect = schematic.getBoundingClientRect();
      let svgRect = this.svg.getBoundingClientRect();
      let overflowX = Math.abs(schematicRect.width/2 - svgRect.width/2 - 10);
      let overflowY = Math.abs(schematicRect.height/2 - svgRect.height/2 - 10);
      partMovement = {
        part: this,
        shiftX: schematicRect.left + schematicRect.width/2 - svgRect.width/2 + (e.pageX - svgRect.left),
        shiftY: schematicRect.top + schematicRect.height/2 - svgRect.height/2 + (e.pageY - svgRect.top),
        overflowX: overflowX,
        overflowY: overflowY,
      };
    }.bind(this);
  }
}

// Code to handle dragging of parts.
// More information: https://javascript.info/mouse-drag-and-drop

let partMovement = null;

document.addEventListener('mousemove', e => {
  if (partMovement) {
    let part = partMovement.part;
    let x = e.pageX - partMovement.shiftX;
    let y = e.pageY - partMovement.shiftY;
    // Make sure the x and y coordinates stay within the allowed space, but
    // don't 'jump' when the part is already outside the allowed space.
    let minX = Math.min(-partMovement.overflowX, part.data.x);
    let minY = Math.min(-partMovement.overflowY, part.data.y);
    let maxX = Math.max(partMovement.overflowX, part.data.x);
    let maxY = Math.max(partMovement.overflowY, part.data.y);
    x = Math.min(maxX, Math.max(minX, x));
    y = Math.min(maxY, Math.max(minY, y));
    part.setPosition(x, y);
  }
});

document.addEventListener('mouseup', e => {
  if (partMovement){
    saveState();
    partMovement = null;
  }
});

// Work around a positioning bug in Chrome and a rendering bug in Firefox.
// It might be possible to remove this code once these bugs are fixed.
let fixPartsLocation = (function() {
  // The code below has multiple purposes.
  //  1. It works around a Chrome/Safari bug. See:
  //     https://bugs.chromium.org/p/chromium/issues/detail?id=1281085
  //  2. It fixes SVG rendering issues on Firefox. Without it, parts of the SVG
  //     might disappear.
  // Both appear to be caused by the "transform: translate(50%, 50%)" style.
  let schematic = document.querySelector('#schematic');
  let partsGroup = document.querySelector('#schematic-parts');
  return function() {
    let rect = schematic.getBoundingClientRect();
    partsGroup.style.transform = 'translate(' + rect.width / 2 + 'px, ' + rect.height / 2 + 'px)';
  };
})();
window.addEventListener('load', fixPartsLocation);
window.addEventListener('resize', fixPartsLocation);
