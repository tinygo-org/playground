'use strict';

// This file emulates a hardware board with an MCU and a set of external
// devices (LEDs etc.).

let terminal;

// The number of CSS pixels in a CSS millimeter. Yes, this is a constant,
// defined by the CSS specification. This doesn't correspond exactly to
// real-world pixels and millimeters, but millimeters should be pretty close.
// For more information:
// https://developer.mozilla.org/en-US/docs/Learn/CSS/Building_blocks/Values_and_units
const pixelsPerMillimeter = 96 / 25.4;

class Schematic {
  constructor(state) {
    this.state = state;
    this.schematic = document.querySelector('#schematic');
    this.propertiesContainer = document.querySelector('#properties');
  }

  // getPin returns a pin object based on a given ID (such as main.D13).
  getPin(id) {
    let pos = id.lastIndexOf('.');
    if (pos < 0) {
      throw new Error('invalid pin ID');
    }
    return this.parts[id.slice(0, pos)].pins[id.slice(pos+1)];
  }

  // Remove and redraw all the SVG parts from scratch.
  async refresh() {
    // Load all the parts in parallel!
    let promises = [];
    for (let [id, data] of Object.entries(this.state.parts)) {
      promises.push(Part.load(id, data, this));
    }
    let parts = await Promise.all(promises);
    this.parts = {};
    for (let part of parts) {
      this.parts[part.id] = part;
    }

    // Remove existing SVG elements.
    let partsGroup = this.schematic.querySelector('#schematic-parts');
    let wireGroup = this.schematic.querySelector('#schematic-wires');
    for (let child of partsGroup.children) {
      child.remove();
    }
    for (let child of wireGroup.children) {
      child.remove();
    }

    // Put SVGs in the schematic.
    let partHeights = [];
    for (let part of Object.values(this.parts)) {
      if (part.svg) {
        partsGroup.appendChild(part.createElement(this.schematic));

        // Store the height, to calculate the minimum height of the schematic.
        // Add a spacing of 20px so that the board has a bit of spacing around it.
        partHeights.push('calc(' + part.height + ' + 20px)');
      }
    }

    // Set the height of the schematic.
    this.schematic.classList.toggle('d-none', partHeights.length === 0);
    if (partHeights.length) {
      this.schematic.style.height = 'max(' + partHeights.join(', ') + ')';
    }

    // Workaround for Chrome positioning bug and Firefox rendering bug.
    fixPartsLocation();

    // Create wires.
    this.wires = [];
    for (let config of this.state.wires) {
      let from = this.getPin(config.from);
      let to = this.getPin(config.to);
      let wire = new Wire(from, to);
      this.wires.push(wire);
      wireGroup.appendChild(wire.line);
      wire.updateFrom();
      wire.updateTo();
    }
  }

  // Create a 'config' struct with a flattened view of the schematic, to be sent
  // to the worker.
  configForWorker() {
    let config = {
      parts: [],
      wires: [],
    };
    for (let [id, part] of Object.entries(this.parts)) {
      // The main part is the part running the code.
      if (id === 'main') {
        config.mainPart = 'main.' + part.config.mainPart;
      }

      // Add part as a board part.
      let board = {
        type: 'board',
        id: id,
        pins: [],
      };
      for (let name in part.pins) {
        board.pins.push(name);
      }
      config.parts.push(board);

      // Add subparts.
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

    // Wires manually added in the schematic.
    for (let wire of this.wires) {
      config.wires.push({
        from: wire.from.id,
        to: wire.to.id,
      });
    }

    return config;
  }

  // addProperties adds the list of part properties to the bottom "properties"
  // panel. It returns an object that should later be passed to updateParts to
  // update the needed parts.
  addProperties(properties) {
    this.propertiesContainer.innerHTML = '';

    this.propertyElements = {};
    for (let property of properties) {
      // Add property name (usually the device name).
      let nameEl = document.createElement('div');
      this.propertiesContainer.appendChild(nameEl);
      nameEl.textContent = property.humanName + ':';

      // Add value of property.
      let valueEl = document.createElement('div');
      this.propertiesContainer.appendChild(valueEl);
      if (property.type === 'text') {
        // Simple text property.
        this.propertyElements[property.id] = {text: valueEl};
      } else if (property.type === 'ledstrip') {
        // Display the colors of this LED strip.
        let header = document.createElement('div');
        valueEl.classList.add('ledstrip');
        valueEl.appendChild(header);
        for (let color of property.colors) {
          let colorHeader = document.createElement('div');
          colorHeader.textContent = color.title+':';
          header.appendChild(colorHeader);
        }

        // Add information for each LED.
        let stripElements = [];
        for (let i=0; i<property.length; i++) {
          let el = document.createElement('div');
          valueEl.appendChild(el);
          let ledElements = [];
          for (let color of property.colors) {
            let channelEl = document.createElement('div');
            channelEl.classList.add('ledstrip-channel');
            el.appendChild(channelEl);
            ledElements.push(channelEl);
          }
          stripElements.push(ledElements);
        }
        this.propertyElements[property.id] = {
          colors: property.colors,
          ledstrip: stripElements,
        };
      } else {
        console.warn('unknown property type:', property.type);
      }
    }
  }

  // Update a (sub)part in the UI with the given updates coming from the web
  // worker that's running the simulated program.
  update(updates) {
    for (let update of updates) {
      let partId = update.id.split('.', 1)[0];
      let part = this.parts[partId].subparts[update.id];

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
        terminal.log(update.logText);
      }

      // Update the properties panel at the bottom if needed.
      // TODO: use IntersectionObserver to only update these properties when
      // visible! That should reduce CPU usage for fast-changing properties.
      if (update.properties) {
        let prop = this.propertyElements[update.id];
        if (prop.text) {
          // Simple text-based property.
          prop.text.textContent = update.properties;
        } else if (prop.ledstrip) {
          // LED strip in various color combinations.
          for (let i=0; i<prop.ledstrip.length; i++) {
            let ledElements = prop.ledstrip[i];
            let values = update.properties[i];
            for (let j=0; j<ledElements.length; j++) {
              let channel = ledElements[j];
              let value = values[j];
              channel.textContent = value;
              let color = { // use the theme's ANSI colors on VS Code
                'red': 'var(--vscode-terminal-ansiRed, #f00)',
                'green': 'var(--vscode-terminal-ansiGreen, #0f0)',
                'blue': 'var(--vscode-terminal-ansiBlue, #00f)',
              }[prop.colors[j].color];
              channel.style.backgroundImage = 'linear-gradient(to left, '+color+' '+(value/255*75)+'%, transparent 0%)';
            }
          }
        } else {
          console.warn('unknown property:', update.properties);
        }
      }
    }
  }

  // findWire returns the index for the first wire between the given two pins,
  // or -1 if no such wire exists.
  findWire(from, to) {
    for (let i=0; i<this.state.wires.length; i++) {
      let wire = this.state.wires[i];
      if (wire.from === from && wire.to === to || wire.from === to && wire.to === from) {
        return i;
      }
    }
    return -1;
  }

  // removeWire removes the given wire from the schematic state. It does not
  // remove the wire from the UI.
  removeWire(from, to) {
    let index = schematic.findWire(from, to);
    schematic.state.wires.splice(index, 1);
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

// Terminal at the bottom of the screen.
class Terminal {
  constructor(textarea) {
    this.textarea = textarea;
    this.observer = new IntersectionObserver(this.intersectionChange.bind(this));
    this.observer.observe(this.textarea);
    this.isVisible = true;
    this.text = '';
  }

  intersectionChange(entries) {
    let isVisible = entries[0].isIntersecting;
    if (isVisible && !this.isVisible) {
      // Textarea became visible, so update its contents.
      this.updateText();
    }
    this.isVisible = isVisible;
  }

  // Change the terminal to show the given error message, in red.
  showError(message) {
    this.textarea.placeholder = '';
    this.text = message;
    this.textarea.value = message;
    this.textarea.classList.add('error');
  }

  // clear any existing content from the terminal (including a possible error
  // message) and set the given placeholder.
  clear(placeholder) {
    this.textarea.placeholder = placeholder;
    this.text = '';
    this.textarea.value = '';
    this.textarea.classList.remove('error');
  }

  // log writes the given message to the terminal. Note that it doesn't append a
  // newline at the end.
  log(msg) {
    this.text += msg;
    if (this.isVisible) {
      this.updateText();
    }
  }

  // Internal function. Update the text in the textarea to reflect this.text
  // while keeping the scroll position at the bottom if it was already there.
  updateText() {
    let distanceFromBottom = this.textarea.scrollHeight - this.textarea.scrollTop - this.textarea.clientHeight;
    this.textarea.value = this.text;
    if (distanceFromBottom < 2) {
      this.textarea.scrollTop = this.textarea.scrollHeight;
    }
  }
}

// Cached JSON requests.
var jsonRequests = {};

// loadJSON returns the JSON at the given location and caches the result for
// later re-use. The response must not be modified.
async function loadJSON(location) {
  if (!(location in jsonRequests)) {
    jsonRequests[location] = (async () => {
      let response = await fetch(location);
      return await response.json();
    })();
  }
  return await jsonRequests[location];
}

// One independent part in the schematic. This might be a separate part like a
// LED, or it might be a board that itself also contains parts. Parts on a board
// are represented differently, though.
class Part {
  constructor(id, config, data, schematic) {
    this.id = id;
    this.config = config;
    this.data = data;
    this.schematic = schematic;
    this.subparts = {};
    this.pins = {};
  }

  // Load the given part and return it (because constructor() can't be async).
  static async load(id, data, schematic) {
    let config = await loadJSON(data.location);
    let part = new Part(id, config, data, schematic);
    if (part.config.svg) {
      await part.loadSVG();
    }
    return part;
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

    // Detect pins inside the SVG file. They have an attribute like
    // data-pin="D5".
    let wireGroup = document.querySelector('#schematic-wires');
    for (let el of this.svg.querySelectorAll('[data-pin]')) {
      // Add dot in the middle (only visible on hover).
      let area = el.querySelector('.area');
      let dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.classList.add('pin-hover-dot');
      dot.style.cx = 'calc(' + area.getAttribute('width') + 'px / 2)';
      dot.style.cy = 'calc(' + area.getAttribute('height') + 'px / 2)';
      el.appendChild(dot);

      // Create pin, to attach wires to.
      let pin = new Pin(this, el.dataset.pin, dot);
      this.pins[pin.name] = pin;

      // Create a wire by clicking on the pin.
      el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (newWire === null) {
          // Create new wire.
          newWire = new Wire(pin, null);
          newWire.updateFrom();
          newWire.updateToMovement(e.pageX, e.pageY);
          wireGroup.appendChild(newWire.line);
        } else if (newWire.from === pin) {
          // Cancel the creation of this wire: it doesn't go anywhere.
          newWire.remove();
          newWire = null;
        } else {
          let config = {from: newWire.from.id, to: pin.id};
          if (this.schematic.findWire(config.from, config.to) >= 0) {
            // This wire already exists. Remove the to-be-created wire.
            console.warn('ignoring duplicate wire');
            newWire.remove();
            newWire = null;
            return;
          }
          // Finish creation of the wire.
          newWire.setTo(pin);
          this.schematic.state.wires.push(config);
          saveState();
          workerPostMessage({
            type: 'add-wire',
            wire: config,
          });
          newWire.select();
          newWire = null;
        }
      });
    }

    return this.wrapper;
  }

  // Set a new (x, y) position in pixels, relative to the center.
  // The position is stored as millimeters, not as pixels.
  setPosition(x, y) {
    this.data.x = x / pixelsPerMillimeter;
    this.data.y = y / pixelsPerMillimeter;
    this.updatePosition();

    // Update wires
    for (let pin of Object.values(this.pins)) {
      for (let wire of pin.wires) {
        if (wire.from === pin) {
          wire.updateFrom();
        }
        if (wire.to === pin) {
          wire.updateTo();
        }
      }
    }
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
      if (newWire) {
        // Don't drag while in the process of adding a new wire.
        return;
      }
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

// A pin wraps a visible pin in the SVG, such as a header pin or a copper area
// on a board. Wires can be attached to such a pin.
class Pin {
  constructor(part, name, dot) {
    this.part = part; // Part object
    this.name = name; // pin name (string)
    this.dot = dot; // SVG object to use as center point
    this.wires = new Set();
  }

  get id() {
    return this.part.id + '.' + this.name;
  }

  // Get the center coordinates of this pin.
  getCoords() {
    let dotRect = this.dot.getBoundingClientRect();
    let x = dotRect.x + dotRect.width/2 - schematicRect.x - schematicRect.width/2;
    let y = dotRect.y + dotRect.width/2 - schematicRect.y - schematicRect.height/2;
    return [x, y];
  }
}

// A wire is a manually drawn wire between two boards (or even between pins of
// the same board).
class Wire {
  constructor(from, to) {
    this.from = from;
    from.wires.add(this);
    if (to) {
      this.to = to;
      to.wires.add(this);
    }
    this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.line.classList.add('wire');
    this.line.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.select();
    });
  }

  // Update based on the coordinates of the 'from' pin.
  updateFrom() {
    [this.x1, this.y1] = this.from.getCoords();
    this.line.setAttribute('x1', this.x1);
    this.line.setAttribute('y1', this.y1);
  }

  // Update based on the coordinates of the 'to' pin.
  updateTo() {
    [this.x2, this.y2] = this.to.getCoords();
    this.line.setAttribute('x2', this.x2);
    this.line.setAttribute('y2', this.y2);
  }

  // Set 'to' pin. May be called when a wire is just created in the UI.
  setTo(to) {
    this.to = to;
    this.to.wires.add(this);
    this.updateTo();
  }

  // Update 'to' position based on the given page coordinates. Called from a
  // mousemove event when in the process of creating a new wire.
  updateToMovement(pageX, pageY) {
    // Calculate x2/y2 based on pointer position.
    this.x2 = pageX - schematicRect.x - schematicRect.width/2;
    this.y2 = pageY - schematicRect.y - schematicRect.height/2;
    // Reduce length of the wire slightly so that hover still works.
    let width = this.x2 - this.x1;
    let height = this.y2 - this.y1;
    let length = Math.sqrt(width*width + height*height); // Pythagoras
    const reduce = pixelsPerMillimeter + 1;
    if (length > reduce) {
      this.x2 -= width / length * reduce;
      this.y2 -= height / length * reduce;
    } else {
      // Too close to the origin point.
      this.x2 = this.x1;
      this.y2 = this.y1;
    }
    // Update the SVG line.
    this.line.setAttribute('x2', this.x2);
    this.line.setAttribute('y2', this.y2);
  }

  select() {
    if (selected) {
      selected.deselect();
    }
    this.line.classList.add('selected');
    selected = this;
  }

  deselect() {
    this.line.classList.remove('selected');
    selected = null;
  }

  // Remove the line everwhere: from the UI and from the associated Pin objects.
  remove() {
    // Remove from UI.
    this.from.wires.delete(this);
    if (this.to) {
      this.to.wires.delete(this);
    }
    this.line.remove();

    if (this.to) {
      // Remove from saved state.
      let schematic = this.from.part.schematic;
      schematic.removeWire(this.from.id, this.to.id);

      // Remove from running circuit.
      workerPostMessage({
        type: 'remove-wire',
        wire: {from: this.from.id, to: this.to.id},
      });
    }
  }
}

// Code to handle dragging of parts and creating of wires.
// More information: https://javascript.info/mouse-drag-and-drop

let partMovement = null;
let newWire = null;
let selected = null;

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
  if (newWire) {
    newWire.updateToMovement(e.pageX, e.pageY);
  }
});

document.addEventListener('mouseup', e => {
  if (partMovement){
    saveState();
    partMovement = null;
  }
});

document.addEventListener('click', e => {
  if (newWire) {
    // Clicked anywhere other than a pin while creating a new wire. Interpret
    // this as cancelling the 'create wire' operation.
    newWire.remove();
    newWire = null;
  } else if (selected) {
    selected.deselect();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && newWire) {
    // Cancel the creation of a new wire.
    e.preventDefault();
    newWire.remove();
    newWire = null;
  } else if (e.key === 'Escape' && selected) {
    selected.deselect();
  } else if (e.key === 'Delete' && selected) {
    selected.remove();
    selected = null;
    saveState();
  }
});

document.addEventListener('DOMContentLoaded', e => {
  terminal = new Terminal(document.querySelector('#terminal'));

  // Switch active tab on click of a tab title.
  for (let tab of document.querySelectorAll('.tabbar > .tab')) {
    tab.addEventListener('click', e => {
      // Update active tab.
      let tabbar = tab.parentNode;
      tabbar.querySelector(':scope > .tab.active').classList.remove('active');
      tab.classList.add('active');

      // Update active tab content.
      let parent = tabbar.parentNode;
      parent.querySelector(':scope > .tabcontent.active').classList.remove('active');
      parent.querySelector(tab.dataset.for).classList.add('active');
    });
  }
});

// Work around a positioning bug in Chrome and a rendering bug in Firefox.
// It might be possible to remove this code once these bugs are fixed.
// https://bugs.chromium.org/p/chromium/issues/detail?id=1281085
// https://bugzilla.mozilla.org/show_bug.cgi?id=1747238
let schematicRect;
let fixPartsLocation = (function() {
  // The code below has multiple purposes.
  //  1. It works around a Chrome/Safari bug. See:
  //     https://bugs.chromium.org/p/chromium/issues/detail?id=1281085
  //  2. It fixes SVG rendering issues on Firefox. Without it, parts of the SVG
  //     might disappear.
  // Both appear to be caused by the "transform: translate(50%, 50%)" style.
  let schematic = document.querySelector('#schematic');
  let wrapper = document.querySelector('#schematic-wrapper');
  return function() {
    schematicRect = schematic.getBoundingClientRect();
    wrapper.style.transform = 'translate(' + schematicRect.width / 2 + 'px, ' + schematicRect.height / 2 + 'px)';
  };
})();
window.addEventListener('load', fixPartsLocation);
window.addEventListener('resize', fixPartsLocation);
