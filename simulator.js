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
    this.propertiesContainer = document.querySelector('#properties .content');
    this.setSpeed(1);
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

    // Remove existing SVG elements.
    let partsGroup = this.schematic.querySelector('#schematic-parts');
    let wireGroup = this.schematic.querySelector('#schematic-wires');
    partsGroup.innerHTML = '';
    wireGroup.innerHTML = '';

    // Put SVGs in the schematic.
    this.parts = {};
    let partHeights = [];
    for (let part of parts) {
      this.addPart(part);

      // Store the height, to calculate the minimum height of the schematic.
      // Add a spacing of 20px so that the board has a bit of spacing around it.
      if (part.rootElement) {
        partHeights.push('calc(' + part.height + ' + 20px)');
      }
    }

    // Set the height of the schematic.
    document.body.classList.toggle('no-schematic', partHeights.length === 0);
    if (partHeights.length) {
      this.schematic.style.height = 'max(' + partHeights.join(', ') + ')';
    } else {
      document.querySelector('.tab[data-for="#terminal-box"]').click();
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

  addPart(part) {
    this.parts[part.id] = part;
    part.createSubParts();
    for (let [id, subpart] of Object.entries(part.subparts)) {
      this.parts[id] = subpart;
    }
    if (part.rootElement) {
      let partsGroup = this.schematic.querySelector('#schematic-parts');
      partsGroup.appendChild(part.createElement(this.schematic));
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

      // Add this part.
      config.parts.push(part.workerConfig());

      // Add internal wires. Think of them as copper traces on a board.
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

  // setProperties sets the list of part properties to the bottom "properties"
  // panel.
  setProperties(properties) {
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
      let part = this.parts[update.id];

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
        part.rootElement.style.setProperty('--' + key, value);
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

  // updateConnections updates the current netlist as calculated by the web
  // worker. It is used to show connected pins and wires when hovering over
  // them.
  updateConnections(lists) {
    for (let pinIds of lists) {
      let pins = [];
      for (let pinId of pinIds) {
        let pin = this.getPin(pinId);
        if (pin) {
          pins.push(pin);
          pin.connected = pins;
        }
      }
    }
  }

  // Set the speed of the simulator, which is currently assumed to be 1 (normal
  // speed) or 0 (stopped).
  setSpeed(speed) {
    let button = document.querySelector('#schematic-button-pause');
    button.disabled = false;
    if (speed === 0) {
      button.textContent = '▶'; // paused, so show play symbol
    } else {
      button.textContent = '⏸';
    }
  }
}

// highlightConnection adds the .hover-connection to all given pins and
// connected wires.
function highlightConnection(pins) {
  if (!pins) {
    return;
  }
  for (let connectedPin of pins) {
    connectedPin.element.classList.add('hover-connection');
    for (let wire of connectedPin.wires) {
      wire.line.classList.add('hover-connection');
    }
  }
}

// unhighlightConnection undoes highlightConnection.
function unhighlightConnection(pins) {
  if (!pins) {
    return;
  }
  for (let connectedPin of pins) {
    connectedPin.element.classList.remove('hover-connection');
    for (let wire of connectedPin.wires) {
      wire.line.classList.remove('hover-connection');
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

// Cached JSON and SVG requests.
var requestCache = {};

// loadJSON returns the JSON at the given location and caches the result for
// later re-use. The response must not be modified.
async function loadJSON(location) {
  if (!(location in requestCache)) {
    requestCache[location] = (async () => {
      let response = await fetch(location);
      return await response.json();
    })();
  }
  return await requestCache[location];
}

// loadSVG returns a SVG root object loaded from the given location and caches
// the result for later re-use. The response is cloned before returning, so can
// be modified by the caller.
async function loadSVG(location) {
  if (!(location in requestCache)) {
    requestCache[location] = new Promise((resolve, reject) => {
      // Load the SVG file.
      // Doing this with XHR because XHR allows setting responseType while the
      // newer fetch API doesn't.
      let xhr = new XMLHttpRequest();
      xhr.open('GET', location);
      xhr.responseType = 'document';
      xhr.send();
      xhr.onload = (() => {
        resolve(xhr.response.rootElement);
      }).bind(this);
    });
  }
  let svg = await requestCache[location];
  return svg.cloneNode(true);
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
    let config = {};
    if (data.location) {
      // Config object is stored in an external JSON file. Need to load that
      // first.
      config = await loadJSON(data.location);
    } else if (data.config) {
      // Config is stored directly in the (modifiable) data object.
      // For example, this may be a simple part created in the Add tab.
      config = data.config;
    }
    let part = new Part(id, config, data, schematic);
    if (part.config.svg) {
      await part.loadSVG();
    }
    return part;
  }

  // loadSVG loads the 'svg' property (this.svg) of this object.
  async loadSVG() {
    // Determine the SVG URL, which is relative to the board config JSON file.
    let svgUrl = new URL(this.config.svg, new URL('parts/', document.baseURI));

    let svg = await loadSVG(svgUrl);
    this.setRootElement(svg);
    this.width = this.rootElement.getAttribute('width');
    this.height = this.rootElement.getAttribute('height');
  }

  createSubParts() {
    this.subparts = {};
    for (let subconfig of this.config.parts || []) {
      let id = this.id + '.' + subconfig.id;
      let subpart = new Part(id, subconfig, {}, this.schematic);
      this.subparts[id] = subpart;
    }
  }

  // Create the wrapper for the part SVG and initialize it.
  createElement(schematic) {
    this.wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.wrapper.setAttribute('class', 'board-wrapper');

    // Add background rectangle.
    let background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.classList.add('background');
    background.setAttribute('width', this.width);
    background.setAttribute('height', this.height);
    this.wrapper.appendChild(background);

    // Add SVG to the schematic at the correct location.
    this.wrapper.appendChild(this.rootElement);
    this.updatePosition();

    // Add some default styles.
    if (this.config.type === 'led' && this.config.color) {
      let [r, g, b] = this.config.color;
      this.rootElement.style.setProperty('--plastic', 'rgba(' + r/2 + ', ' + g/2 + ', ' + b/2 + ', 0.8)');
    }

    // Make the part draggable with a mouse.
    this.wrapper.ondragstart = e => false;
    this.wrapper.onmousedown = function(e) {
      if (newWire || newPart) {
        // Don't drag while in the process of adding a new wire.
        return;
      }
      this.select();
      // Calculate as many things as possible in advance, so that the mousemove
      // event doesn't have to do much.
      // This code handles the following cases:
      //   * Don't let parts be moved outside the available space.
      //   * ...except if the available space is smaller than the part, in which
      //     case it makes more sense to limit movement to stay entirely within
      //     the available space.
      let schematicRect = schematic.getBoundingClientRect();
      let svgRect = this.rootElement.getBoundingClientRect();
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

    // Make the part selectable.
    this.wrapper.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.select();
    });

    // Detect parts inside the SVG file. They have a tag like
    // data-part="led".
    for (let el of this.rootElement.querySelectorAll('[data-part]')) {
      let id = this.id+'.'+el.dataset.part;
      let part = this.subparts[id];
      if (!part) {
        console.warn('part not found:', id);
        continue;
      }
      part.setRootElement(el);
    }

    // Detect pins inside the SVG file. They have an attribute like
    // data-pin="D5".
    let wireGroup = document.querySelector('#schematic-wires');
    let tooltip = document.querySelector('#schematic-tooltip');
    for (let el of this.rootElement.querySelectorAll('[data-pin]')) {
      if (el.dataset.pin.includes('.')) {
        console.warn('pin name contains dot:', el.dataset.pin);
        continue;
      }
      // Add dot in the middle (only visible on hover).
      let area = el.querySelector('.area');
      let dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.classList.add('pin-hover-dot');
      dot.style.cx = 'calc(' + area.getAttribute('width') + 'px / 2)';
      dot.style.cy = 'calc(' + area.getAttribute('height') + 'px / 2)';
      el.appendChild(dot);

      // Create pin, to attach wires to.
      let pin = new Pin(this, el.dataset.pin, el, dot);
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
          document.body.classList.add('adding-wire');
        } else if (newWire.from === pin) {
          // Cancel the creation of this wire: it doesn't go anywhere.
          newWire.remove();
        } else {
          let config = {from: newWire.from.id, to: pin.id};
          if (this.schematic.findWire(config.from, config.to) >= 0) {
            // This wire already exists. Remove the to-be-created wire.
            console.warn('ignoring duplicate wire');
            newWire.remove();
            return;
          }
          // Finish creation of the wire.
          newWire.setTo(pin);
          this.schematic.state.wires.push(config);
          saveState();
          workerPostMessage({
            type: 'add',
            wires: [config],
          });
          newWire.select();
          newWire = null;
          document.body.classList.remove('adding-wire');
        }
      });

      // Show a tooltip when hovering over the pin.
      let pinTitle = el.dataset.title || pin.name;
      el.addEventListener('mouseenter', e => {
        highlightConnection(pin.connected);
        tooltip.textContent = pinTitle;
        let dotRect = pin.dot.getBoundingClientRect();
        tooltip.style.top = (dotRect.y - schematicRect.y - 30) + 'px';
        tooltip.style.left = (dotRect.x + dotRect.width/2 - schematicRect.x - 11.5) + 'px';
        tooltip.classList.add('visible');
      });
      el.addEventListener('mouseleave', e => {
        unhighlightConnection(pin.connected);
        if (tooltip.textContent !== pinTitle) {
          // Already entered a different pin, ignore.
          return;
        }
        tooltip.classList.remove('visible');
      });
    }

    return this.wrapper;
  }

  setRootElement(el) {
    this.rootElement = el;
    this.leds = el.querySelectorAll('[data-type="rgbled"]');
    this.context = null;
    if (el.nodeName === 'CANVAS') {
      this.context = el.getContext('2d');
    }
  }

  // workerConfig returns a config object for this part to be sent to the web
  // worker.
  workerConfig() {
    if (!this.config.type) {
      // Add part as a board part. Boards aren't active, they only provide pins
      // to attach to.
      let subconfig = {
        type: 'board',
        id: this.id,
        pins: [],
      };
      for (let name in this.pins) {
        subconfig.pins.push(name);
      }
      return subconfig;
    }

    // Regular part (probably sitting on a board).
    return Object.assign({}, this.config, {id: this.id});
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

  select() {
    if (selected) {
      selected.deselect();
    }
    this.wrapper.classList.add('selected');
    selected = this;
  }

  deselect() {
    this.wrapper.classList.remove('selected');
    selected = null;
  }

  // Remove the part everywhere, recursively, both in the UI and in the saved
  // state. Also create a message to be sent to the web worker to remove the
  // equivalent parts and wires there but don't send it yet: this is the job of
  // the caller.
  remove() {
    // Remove all wires to start with.
    let message = {
      type: 'remove',
      parts: [],
      wires: [],
    };
    for (let pin of Object.values(this.pins)) {
      for (let wire of pin.wires) {
        let msg = wire.remove();
        message.wires.push(...msg.wires);
      }
    }

    // Remove the sub-parts.
    for (let subpart of Object.values(this.subparts)) {
      console.warn('todo: remove subpart', subpart.id);
    }

    // Remove the main part.
    delete this.schematic.parts[this.id];
    delete this.schematic.state.parts[this.id];
    message.parts.push(this.id);
    this.wrapper.remove();

    return message;
  }
}

// A pin wraps a visible pin in the SVG, such as a header pin or a copper area
// on a board. Wires can be attached to such a pin.
class Pin {
  constructor(part, name, element, dot) {
    this.part = part; // Part object
    this.name = name; // pin name (string)
    this.element = element; // the containing element for this pin (with data-pin="...")
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
    this.line.addEventListener('mouseenter', e => {
      if (this.from && this.to) {
        highlightConnection(this.from.connected);
      }
    });
    this.line.addEventListener('mouseleave', e => {
      if (this.from && this.to) {
        unhighlightConnection(this.from.connected);
      }
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
    if (this === newWire) {
      newWire = null;
      document.body.classList.remove('adding-wire');
    }

    // Remove from UI.
    this.from.wires.delete(this);
    if (this.to) {
      this.to.wires.delete(this);
    }
    this.line.remove();

    if (!this.to) {
      // Not complete, so don't need to remove the wire except from the UI.
      return;
    }

    // Remove from saved state.
    this.from.part.schematic.removeWire(this.from.id, this.to.id);

    // Remove from running circuit.
    return {
      type: 'remove',
      wires: [{from: this.from.id, to: this.to.id}],
    };
  }
}

// Code to handle dragging of parts and creating of wires.
// More information: https://javascript.info/mouse-drag-and-drop

let partMovement = null;
let newWire = null;
let newPart = null;
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
  if (newPart) {
    let x = e.pageX - schematicRect.width/2 - schematicRect.x;
    let y = e.pageY - schematicRect.height/2 - schematicRect.y;
    newPart.setPosition(x, y);
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
  } else if (selected) {
    selected.deselect();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && newWire) {
    // Cancel the creation of a new wire.
    e.preventDefault();
    newWire.remove();
  } else if (e.key === 'Escape' && selected) {
    selected.deselect();
  } else if (e.key === 'Delete' && selected) {
    if (selected.id === 'main') {
      console.warn('not removing main part');
      return;
    }
    let message = selected.remove();
    selected = null;
    saveState();
    workerPostMessage(message);
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

  // Load parts in the "Add" tab.
  loadPartsPanel();
});

// Initialize the parts panel at the bottom, from where new parts can be added.
async function loadPartsPanel() {
  let panel = document.querySelector('#add');
  let response = await fetch('parts/parts.json');
  let json = await response.json();
  panel.innerHTML = '';
  for (let part of json.parts) {
    let config = {};
    // Show small image of the part.
    let image = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    image.setAttribute('width', '10mm');
    image.setAttribute('height', '10mm');
    image.classList.add('part-image');
    panel.appendChild(image);
    let svgPromise = loadSVG(new URL(part.config.svg, new URL('parts/', document.baseURI)))
    svgPromise.then((svg) => {
      image.appendChild(svg);
      applyOptions();
    });

    // Make sure the image looks as specified in the options (changeable via
    // dropdowns).
    let applyOptions = () => {
      if (config.color) {
        let color = 'rgb(' + config.color[0] + ',' + config.color[1] + ',' + config.color[2] + ')';
        image.style.setProperty('--plastic', color);
        image.style.setProperty('--shadow', color);
      }
    };

    // Part title.
    let titleDiv = document.createElement('div');
    titleDiv.textContent = part.config.humanName;
    panel.appendChild(titleDiv);

    // Options, such as color.
    let optionsDiv = document.createElement('div');
    for (let [optionKey, optionValues] of Object.entries(part.options || {})) {
      let select = document.createElement('select');
      for (let [name, value] of Object.entries(optionValues)) {
        if (!(optionKey in config)) {
          // First option, add it to the config object as default.
          config[optionKey] = value;
        }
        let option = document.createElement('option');
        option.textContent = name;
        option.value = JSON.stringify(value);
        select.appendChild(option);
      }
      select.addEventListener('change', e => {
        let value = JSON.parse(e.target.value);
        config[optionKey] = value;
        applyOptions();
      });
      optionsDiv.appendChild(select);
    }
    panel.appendChild(optionsDiv);

    // Button to add the part to the schematic.
    let buttonDiv = document.createElement('div');
    let button = document.createElement('button');
    button.textContent = 'Add';
    buttonDiv.appendChild(button);
    panel.appendChild(buttonDiv);

    // Start adding a part to the schematic when clicking the button.
    button.addEventListener('click', async e => {
      // Add the part to the UI schematic - but don't really make it part of the
      // running circuit yet. Imagine picking up a part and hovering just above
      // where you want to put it down.
      document.body.classList.add('adding-part');
      let data = {
        config: Object.assign({}, part.config, config, {
          id: Math.random().toString(36).slice(2),
        }),
        x: e.pageX - schematicRect.width/2 - schematicRect.x,
        y: e.pageY - schematicRect.height/2 - schematicRect.y,
      };
      newPart = await Part.load(data.config.id, data, schematic);
      await newPart.loadSVG();
      schematic.addPart(newPart);

      // Truly add the part to the circuit when clicking on it.
      let onclick = e => {
        workerPostMessage({
          type: 'add',
          parts: [newPart.workerConfig()],
        });
        newPart.rootElement.removeEventListener('click', onclick);
        newPart = null;
        document.body.classList.remove('adding-part');
        schematic.state.parts[data.config.id] = data;
        saveState();
      };
      newPart.rootElement.addEventListener('click', onclick);
    });
  }
}

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

document.querySelector('#schematic-button-pause').addEventListener('click', e => {
  e.target.disabled = true; // disable until there's a reply from the worker
  e.stopPropagation();
  workerPostMessage({
    type: 'playpause',
  });
});
