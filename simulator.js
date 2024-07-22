// This file emulates a hardware board with an MCU and a set of external
// devices (LEDs etc.).

export { Simulator };

// The number of CSS pixels in a CSS millimeter. Yes, this is a constant,
// defined by the CSS specification. This doesn't correspond exactly to
// real-world pixels and millimeters, but millimeters should be pretty close.
// For more information:
// https://developer.mozilla.org/en-US/docs/Learn/CSS/Building_blocks/Values_and_units
const pixelsPerMillimeter = 96 / 25.4;

const inputCompileDelay = 1000;

// All the features supported in the 'features' config key.
const allFeatures = ['zoom', 'pan'];

// Encapsulate a single simulator HTML node. Handles starting/stopping the
// worker, refresh the schematic as needed, etc.
class Simulator {
  constructor(config) {
    // Store configuration.
    this.root = config.root;
    this.editor = config.editor;
    this.firmwareButton = config.firmwareButton;
    this.baseURL = config.baseURL || document.baseURI;
    this.apiURL = config.apiURL;
    this.features = new Set(config.features || allFeatures);
    this.schematicURL = config.schematicURL || new URL('./worker/webworker.js', this.baseURL);
    this.runnerURL = config.runnerURL || new URL('./worker/runner.js', this.baseURL);
    this.saveState = config.saveState || (() => {});

    // Initialize member variables.
    this.worker = null;
    this.workerUpdate = null;
    this._schematicRect = null;

    // Initialize root element.
    this.schematicElement = this.root.querySelector('.schematic');
    this.schematicWrapperElement = this.root.querySelector('.schematic-wrapper');
    this.tooltip = new Tooltip(this.root.querySelector('.schematic-tooltip'), this);
    this.#setupRoot();

    // Listen to changes from editor.
    if (this.editor) {
      this.#setupEditor();
    }

    // Make sure the 'download firmware' button works.
    if (this.firmwareButton) {
      this.firmwareButton.addEventListener('click', (e) => this.#flashFirmware(e));
    }

    // Start loading the parts panel (without blocking further initialization).
    this.#loadPartsPanel();
  }

  // Set the project state. This must be done at load, and when the schematic is
  // switched for another. It does _not_ need to happen on each input: that's
  // something the simulator already takes care of.
  async setState(state) {
    // Don't allow downloading the firmware while switching the state out.
    if (this.firmwareButton) {
      this.firmwareButton.disabled = true;
    }

    // Redraw the schematic SVG.
    try {
      await this.refresh(state);
    } catch (e) {
      // Something went wrong. Instead of an endless "Restarting simulation..."
      // message, show it as an error.
      // This can happen for example when one of the SVGs cannot be loaded.
      console.error(e);
      this.terminal.showError(`failed to refresh schematic: ${e}`);
      return;
    }

    // Start first compile.
    if (this.apiURL) {
      // Run the code in a web worker.
      this.#runWithAPI();
    }
  }

  // Return getBoundingClientRect for schematicElement. The value is cached and
  // cleared when scrolling (to make sure it is always up-to-date).
  get schematicRect() {
    if (this._schematicRect === null) {
      this._schematicRect = this.schematicElement.getBoundingClientRect();
    }
    return this._schematicRect;
  }

  // Configure the editor to listen to modifications.
  #setupEditor() {
    // Compile the code after a certain delay of inactivity.
    let inputCompileTimeout = null;
    this.editor.setModifyCallback(() => {
      // This callback is called with every input.
      if (inputCompileTimeout !== null) {
        clearTimeout(inputCompileTimeout);
      }
      inputCompileTimeout = setTimeout(async () => {
        inputCompileTimeout = null;
        this.schematic.state.code = this.editor.text();
        this.saveState();
        await this.refresh();
        this.#runWithAPI();
      }, inputCompileDelay);
    });
  }

  // Start a firmware file download. This can be used for drag-and-drop
  // programming supported by many modern development boards.
  #flashFirmware(e) {
    e.preventDefault();

    // Create a hidden form with the correct values that sends back the file with
    // the correct headers to make this a download:
    //     Content-Disposition: attachment; filename=firmware.hex
    let form = document.createElement('form');
    form.setAttribute('method', 'POST');
    form.setAttribute('action', `${this.apiURL}/compile?target=${this.schematic.parts.get('main').config.name}&format=${this.schematic.parts.get('main').config.firmwareFormat}`);
    form.classList.add('d-none');
    let input = document.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', 'code');
    input.value = this.editor.text();
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  // Initialize this simulator by setting up events etc.
  #setupRoot() {
    this.root.querySelector('.schematic-button-pause').addEventListener('click', e => {
      e.target.disabled = true; // disable until there's a reply from the worker
      e.stopPropagation();
      this.worker.postMessage({
        type: 'playpause',
      });
    });

    if (this.features.has('zoom')) {
      // Zoom using the scroll wheel.
      // Disable the default wheel event: this would result in a bounce effect
      // on Safari and make the scrolling a lot less smooth.
      // TODO: pinch to zoom? (e.g. with a trackpad)
      this.schematicElement.addEventListener('wheel', e => {
        e.preventDefault();
        let [positionX, positionY] = this.schematic.cursorPosition(e);
        let factor = 1 + (e.deltaY * -0.0005);
        this.schematic.zoom(factor, positionX, positionY);
      }, {passive: false});
    }

    if (this.features.has('pan')) {
      // Pan using the secondary (usually right) mouse button.
      this.schematicElement.addEventListener('contextmenu', e => {
        // The default action is a context menu, which we don't want.
        // Firefox allows overriding this using shift (which is good, we don't
        // want to prevent the context menu entirely) while Chromium doesn't.
        e.preventDefault();
      })
      this.schematicElement.addEventListener('mousedown', e => {
        if (e.buttons === 2) {
          // Secondary button pressed (only). Start panning (dragging).
          let [cursorX, cursorY] = this.schematic.cursorPosition(e);
          schematicPan = {
            schematic: this.schematic,
            initialCursorX: cursorX,
            initialCursorY: cursorY,
            initialTranslateX: this.schematic.translateX,
            initialTranslateY: this.schematic.translateY,
          };
        }
      })
      this.schematicElement.addEventListener('mouseup', e => {
        // Stop panning the schematic (no matter which way it ended).
        schematicPan = null;
      })
    }

    // Listen for keyboard events, to simulate button presses.
    this.schematicElement.addEventListener('keydown', e => {
      this.schematic.handleKey(e, true);
    });
    this.schematicElement.addEventListener('keyup', e => {
      this.schematic.handleKey(e, false);
    });
    this.schematicElement.addEventListener('blur', e => {
      // Lost focus, so un-press all pressed keys.
      this.schematic.handleBlur();
    })

    this.terminal = new Terminal(this.root.querySelector('.terminal'));

    // Switch active panel tab on click of a tab title.
    // This is only for the vscode theme.
    let tabs = this.root.querySelectorAll('.panels > .tabbar > .tab');
    for (let i=0; i<tabs.length; i++) {
      let tab = tabs[i];
      let panel = this.root.querySelectorAll('.panels > .tabcontent')[i];
      tab.addEventListener('click', e => {
        // Update active tab.
        let tabbar = tab.parentNode;
        tabbar.querySelector(':scope > .tab.active').classList.remove('active');
        tab.classList.add('active');

        // Update active tab content.
        let parent = tabbar.parentNode;
        parent.querySelector(':scope > .tabcontent.active').classList.remove('active');
        panel.classList.add('active');
      });
    }

    window.addEventListener('load', () => this.fixPartsLocation());
    window.addEventListener('resize', () => this.fixPartsLocation());
    window.addEventListener('scroll', () => {
      // Note: this is a passive event so that it won't reduce scrolling
      // performance.
      this._schematicRect = null;
    }, {passive: true});
  }

  // Initialize the parts panel at the bottom, from where new parts can be
  // added.
  async #loadPartsPanel() {
    let panel = this.root.querySelector('.panel-add');
    let partsURI = new URL('parts/parts.json', this.baseURL)
    let response = await fetch(partsURI);
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
      let svgPromise = loadSVG(new URL(part.config.svg, partsURI))
      svgPromise.then((svg) => {
        // If needed, shrink the image to fit the available space.
        let width = svg.getAttribute('width').replace('mm', '');
        let height = svg.getAttribute('height').replace('mm', '');
        let wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        wrapper.style.transform = `scale(min(1, min(calc(10 / ${width}), calc(10 / ${height}))))`;
        wrapper.appendChild(svg);
        image.appendChild(wrapper);
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
        let select = this.root.querySelector('.templates > .panel-add-select').cloneNode(true);
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
      let button = this.root.querySelector('.templates > .panel-add-button').cloneNode(true);
      buttonDiv.appendChild(button);
      panel.appendChild(buttonDiv);

      // Start adding a part to the schematic when clicking the button.
      button.addEventListener('click', async e => {
        // Add the part to the UI schematic - but don't really make it part of the
        // running circuit yet. Imagine picking up a part and hovering just above
        // where you want to put it down.
        this.root.classList.add('adding-part');
        let data = {
          config: Object.assign({}, part.config, config, {
            id: Math.random().toString(36).slice(2),
          }),
          x: e.pageX - this.schematicRect.width/2 - this.schematicRect.x,
          y: e.pageY - this.schematicRect.height/2 - this.schematicRect.y,
        };
        newPart = await Part.load(data.config.id, data, this.schematic);
        await newPart.loadSVG();
        this.schematic.addPart(newPart);

        // Truly add the part to the circuit when clicking on it.
        let onclick = e => {
          this.worker.postMessage({
            type: 'add',
            parts: [newPart.workerConfig()],
          });
          newPart.rootElement.removeEventListener('click', onclick);
          newPart = null;
          this.root.classList.remove('adding-part');
          this.schematic.state.parts[data.config.id] = data;
          this.saveState();
        };
        newPart.rootElement.addEventListener('click', onclick);
      });
    }
  }

  // Work around a rendering bug in Firefox. Without it, parts of the SVG might
  // disappear. It is caused by "transform: translate(50%, 50%)".
  // It might be possible to remove this code once this bug is fixed.
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1747238
  fixPartsLocation() {
    this._schematicRect = this.schematicElement.getBoundingClientRect();
    this.schematicWrapperElement.style.transform = `translate(${this.schematicRect.width/2}px, ${this.schematicRect.height/2}px)`;
  }

  #stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      if (this.workerUpdate !== null) {
        cancelAnimationFrame(this.workerUpdate);
        this.workerUpdate = null;
      }
    }
  }

  // Refresh simulator. This needs to be called before calling run().
  // It also needs to be called before running new code (by calling run()
  // again).
  // The newState paramter can be provided if the board/schematic will change in
  // the next run.
  async refresh(newState) {
    // Kill previous worker, if it is running.
    this.#stopWorker();

    // If there was a new state (for example, when switching to a different
    // board), restart the Schematic.
    if (newState) {
      this.schematic = new Schematic(this, this.root, newState);
    }

    // Redraw screen.
    this.schematic.root.classList.add('compiling');
    this.terminal.clear('Restarting simulation...');
    await this.schematic.refresh();

    // Only set the firmware button as enabled when supported by the main part.
    if (this.firmwareButton) {
      this.firmwareButton.disabled = this.schematic.parts.get('main').config.firmwareFormat === undefined;
    }

    // Start new worker.
    this.worker = new Worker(this.schematicURL);
    this.worker.onmessage = (e) => {
      this.#workerMessage(e.target, e.data);
    };
  }

  #runWithAPI() {
    let compiler = this.schematic.state.compiler || 'tinygo'; // fallback to tinygo
    this.run({
      url: `${this.apiURL}/compile?compiler=${compiler}&format=wasi&target=${this.schematic.parts.get('main').config.name}`,
      method: 'POST',
      body: this.editor.text(),
    });
  }

  // Run a new binary. The `refresh` method must have been called before to stop
  // the previous run.
  // The binary can either be a Uint8Array or an object with parameters 'url',
  // 'method' and 'body' that can be used in a fetch() call.
  run(binary) {
    this.worker.postMessage({
      type: 'start',
      config: this.schematic.configForWorker(),
      binary: binary,
      runnerURL: this.runnerURL.toString(),
    });
  }

  // Show a compiler error. This can be called instead of run() to show the
  // compiler error in the output view.
  showCompilerError(msg) {
    this.terminal.showError(msg);
  }

  #workerMessage(worker, msg) {
    // Perhaps this worker exited and had some queued messages?
    if (worker !== this.worker) {
      return;
    }

    if (msg.type === 'connections') {
      this.schematic.updateConnections(msg.pinLists);
    } else if (msg.type === 'properties') {
      // Set properties in the properties panel at the bottom.
      this.schematic.setProperties(msg.properties);
    } else if (msg.type === 'compiling') {
      // POST request has been sent, waiting for compilation to finish.
      this.terminal.clear('Compiling...');
    } else if (msg.type == 'loading') {
      // Code has started loading in the worker.
      this.terminal.clear('Loading...');
      // Request an update.
      worker.postMessage({
          type: 'getUpdate',
      });
      // Clear diagnostics left over from a previous compile.
      if (this.editor) {
        this.editor.setDiagnostics([]);
      }
    } else if (msg.type === 'started') {
      // WebAssembly code was loaded and will start now.
      this.schematic.root.classList.remove('compiling');
      this.terminal.clear('Running...');
    } else if (msg.type === 'exited') {
      // TODO: show this in the terminal even when there is some output.
      let text = 'Exited.';
      if (msg.exitCode !== 0) {
        text = `Exited (exitcode: ${msg.exitCode}).`;
      }
      this.terminal.setPlaceholder(text);
    } else if (msg.type == 'notifyUpdate') {
      // The web worker is signalling that there are updates.
      // It won't repeat this message until the updates have been read using
      // getUpdate.
      // Request the updates in a requestAnimationFrame: this makes sure
      // updates are only pushed when needed.
      this.workerUpdate = requestAnimationFrame(() => {
        this.workerUpdate = null;
        // Now request these updates.
        worker.postMessage({
          type: 'getUpdate',
        });
      });
    } else if (msg.type == 'update') {
      // Received updates (such as LED state changes) from the web worker after
      // a getUpdate message.
      // Update the UI with the new state.
      this.schematic.update(msg.updates);
    } else if (msg.type === 'speed') {
      // Change speed, also used to pause the worker.
      this.schematic.setSpeed(msg.speed);
    } else if (msg.type == 'error') {
      // There was an error. Terminate the worker, it has no more work to do.
      this.#stopWorker();
      this.terminal.showError(msg.message);
      if (msg.source === 'compiler') {
        if (this.editor) {
          this.editor.setDiagnostics(parseCompilerErrors(msg.message));
        }
      }
    } else {
      console.warn('unknown worker message:', msg.type, msg);
    }
  }
}

class Schematic {
  constructor(simulator, root, state) {
    this.simulator = simulator;
    this.root = root;
    this.state = state;
    this.schematic = root.querySelector('.schematic');
    this.propertiesContainer = root.querySelector('.panel-properties .content');
    this.setSpeed(1);
    this.scale = 1; // initial scale (1mm in SVG is ~1mm on screen)
    this.translateX = 0; // initial translation (before scaling)
    this.translateY = 0;
    this.pressedKeys = {};
  }

  // getPin returns a pin object based on a given ID (such as main.D13).
  getPin(id) {
    let pos = id.lastIndexOf('.');
    if (pos < 0) {
      throw new Error('invalid pin ID');
    }
    return this.parts.get(id.slice(0, pos)).pins[id.slice(pos+1)];
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
    let partsGroup = this.schematic.querySelector('.schematic-parts');
    let wireGroup = this.schematic.querySelector('.schematic-wires');
    partsGroup.innerHTML = '';
    wireGroup.innerHTML = '';

    // Put SVGs in the schematic.
    this.parts = new Map();
    let hasParts = false;
    let top = 0;
    let bottom = 0;
    for (let part of parts) {
      this.addPart(part);

      // Calculate the minimum area needed for all the parts in the schematic to
      // be visible.
      // Add a spacing of 2.5mm (~10px) so that the board has a bit of spacing
      // around it.
      if (part.rootElement) {
        hasParts = true;
        let height = parseUnitMM(part.height);
        top    = Math.min(top,    part.data.y-height/2 - 2.5);
        bottom = Math.max(bottom, part.data.y+height/2 + 2.5);
      }
    }

    // Set the height of the schematic.
    this.root.classList.toggle('no-schematic', !hasParts);
    if (hasParts) {
      let distance = Math.max(bottom*2, -top*2);
      this.schematic.style.height = distance + 'mm';
    } else {
      this.simulator.root.querySelector('.panel-tab-terminal').click();
    }

    // Workaround for Chrome positioning bug and Firefox rendering bug.
    this.simulator.fixPartsLocation();

    // Create wires.
    this.wires = [];
    for (let config of this.state.wires) {
      let from = this.getPin(config.from);
      let to = this.getPin(config.to);
      if (!from) {
        console.error('could not find "from" pin for wire:', config.from);
        continue;
      }
      if (!to) {
        console.error('could not find "to" pin for wire:', config.to);
        continue;
      }
      let wire = new Wire(this, from, to);
      this.wires.push(wire);
      wireGroup.appendChild(wire.line);
      wire.updateFrom();
      wire.updateTo();
    }
  }

  addPart(part) {
    this.parts.set(part.id, part);
    part.createSubParts();
    for (let [id, subpart] of Object.entries(part.subparts)) {
      this.parts.set(id, subpart);
    }
    if (part.rootElement) {
      let partsGroup = this.schematic.querySelector('.schematic-parts');
      partsGroup.appendChild(part.createElement(this.schematic));
    }
  }

  // Handle keyboard input and emulate these keys as physical keys.
  handleKey(e, pressed) {
    let key = e.key;
    if (key.length === 1) {
      key = key.toUpperCase(); // probably a key like 'A'
    }
    for (let part of this.parts.values()) {
      if (part.config.type === 'pushbutton' && part.config.key === key) {
        if (pressed && this.pressedKeys[key] === part.id) {
          // Repeat key (held down), ignore this event.
          return;
        }
        this.simulator.worker.postMessage({
          type: 'input',
          id: part.id,
          event: pressed ? 'press' : 'release',
        });
        if (pressed) {
          this.pressedKeys[key] = part.id;
        } else {
          delete this.pressedKeys[key];
        }
        return;
      }
    }
  }

  // Release all pressed keys when the schematic loses focus.
  handleBlur() {
    for (let [key, partId] of Object.entries(this.pressedKeys)) {
      this.simulator.worker.postMessage({
        type: 'input',
        id: partId,
        event: 'released',
      });
      delete this.pressedKeys[key];
    }
  }

  // Convert a mouse event into a logical cursor position (in millimeters from
  // the center of the schematic view, before translating/scaling).
  cursorPosition(e) {
    let schematicRect = this.simulator.schematicRect;
    let cursorX = ((e.clientX - schematicRect.left) - schematicRect.width/2) / pixelsPerMillimeter;
    let cursorY = ((e.clientY - schematicRect.top) - schematicRect.height/2) / pixelsPerMillimeter;
    return [cursorX, cursorY];
  }

  // Increase or decrease the scale factor with the given amount.
  zoom(factor, cursorX, cursorY) {
    let newScale = this.scale * factor; // apply scale
    newScale = Math.min(Math.max(this.scale * factor, 0.1), 50); // limit zoom amount
    if (newScale !== this.scale) {
      // Calculate distance between schematic center point and cursor, in
      // pre-scaled millimeters.
      let cursorDiffX = cursorX - this.translateX;
      let cursorDiffY = cursorY - this.translateY;
      // Calculate the change in distance between the schematic center point and
      // the cursor, before and after zooming.
      let diffX = ((cursorDiffX * this.scale) - (cursorDiffX * newScale)) / this.scale;
      let diffY = ((cursorDiffY * this.scale) - (cursorDiffY * newScale)) / this.scale;
      // Apply the new scale (pan+zoom).
      this.translateX += diffX;
      this.translateY += diffY;
      this.scale = newScale;
      this.#repositionParts();
    }
  }

  // Move (pan) the schematic to the new location.
  moveTo(translateX, translateY) {
    this.translateX = translateX;
    this.translateY = translateY;
    this.#repositionParts();
  }

  // Move parts to a new location if needed.
  #repositionParts() {
    // Update all parts (except for subparts).
    // This is done all at once (without updating wires for each part) so that
    // we don't force a reflow.
    for (let part of this.parts.values()) {
      if (!part.parent) {
        part.updatePosition();
      }
    }
    // Calculate new wire locations. This forces a single reflow.
    for (let part of this.parts.values()) {
      if (!part.parent) {
        part.calculateWires();
      }
    }
    // Calculate tooltip location (if visible).
    this.simulator.tooltip.calculatePosition();
    // Apply new wire locations. This only sets properties, so doesn't cause a
    // reflow.
    for (let part of this.parts.values()) {
      if (!part.parent) {
        part.applyWires();
      }
    }
    // Update tooltip location (if visible).
    this.simulator.tooltip.updatePosition();
  }

  // Create a 'config' struct with a flattened view of the schematic, to be sent
  // to the worker.
  configForWorker() {
    let config = {
      parts: [],
      wires: [],
    };
    for (let [id, part] of this.parts.entries()) {
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
      let part = this.parts.get(update.id);

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
        let imageData = new ImageData(update.canvas, part.config.width, part.config.height);
        createImageBitmap(imageData).then(bitmap => {
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
        this.simulator.terminal.log(update.logText);
      }

      // Update the properties panel at the bottom if needed.
      // TODO: use IntersectionObserver to only update these properties when
      // visible! That should reduce CPU usage for fast-changing properties.
      if (update.properties) {
        let prop = this.propertyElements[update.id];
        if (!prop) {
          console.error('properties not defined for ' + update.id);
        } else if (prop.text) {
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
    let index = this.findWire(from, to);
    this.state.wires.splice(index, 1);
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
    this.root.querySelector('.schematic-button-pause').disabled = false;
    this.root.classList.toggle('paused', speed === 0);
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
    this.setPlaceholder(placeholder);
    this.text = '';
    this.textarea.value = '';
    this.textarea.classList.remove('error');
  }

  // Update the placeholder but don't change the contents of the terminal.
  setPlaceholder(placeholder) {
    this.textarea.placeholder = placeholder;
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

// Tooltip that's shown when hovering over some things (like a pin).
class Tooltip {
  constructor(element, simulator) {
    this.object = null;     // the object for which this tooltip is shown
    this.element = element; // the tooltip element
    this.simulator = simulator;
    this.onremove = null;        // callback to call when the tooltip is hidden (for whatever reason)
    this.calculateCoords = null; // callback to receive the current tooltip coordinates
  }

  // Create a new tooltip, or replace an existing one.
  //
  //   object: a reference object, used to identify a tooltip for one unique object.
  //   text: the text contents of the tooltip
  //   onremove: callback to call when the tooltip is removed.
  //   calculateCoords: callback to obtain the current tooltip coordinates (returns [x, y]).
  create(object, text, onremove, calculateCoords) {
    // Replace previous tooltip, if it exists.
    if (this.object) {
      this.remove(this.object);
    }

    // Set up a new tooltip.
    this.object = object;
    this.element.textContent = text;
    this.calculateCoords = calculateCoords;
    this.calculatePosition();
    this.updatePosition();
    this.element.classList.add('visible');
    this.onremove = onremove;
  }

  // Remove a tooltip. The 'object' paramter must be the same that was passed to
  // 'create'.
  remove(object) {
    if (object !== this.object) {
      // Not the current object (e.g. a new tooltip may be shown before the old
      // one was removed).
      return;
    }

    // Remove the tooltip.
    this.element.classList.remove('visible');
    if (this.onremove) {
      this.onremove();
      this.onremove = null;
    }
    this.calculateCoords = null;
  }

  // Determine the new location of the tooltip, if there is a visible tooltip.
  // This may force a layout, but won't affect the DOM.
  calculatePosition() {
    if (this.calculateCoords !== null) {
      [this.top, this.left] = this.calculateCoords();
    }
  }

  // Apply previously calculated position (see calculatePosition) to the DOM.
  // This won't force a layout, it only writes to the DOM.
  updatePosition() {
    if (this.calculateCoords !== null) {
      let schematicRect = this.simulator.schematicRect;
      this.element.style.top = (this.top - schematicRect.y - 30) + 'px';
      this.element.style.left = (this.left - schematicRect.x - 11.5) + 'px';
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
      if (!response.ok) {
        throw `Could not request JSON at ${location}: HTTP error ${response.status} ${response.statusText}`;
      }
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
      // Reject the request on error so that we can at least show something went
      // wrong in the UI (instead of hanging on "Restarting simulation...").
      let xhr = new XMLHttpRequest();
      xhr.open('GET', location);
      xhr.responseType = 'document';
      xhr.send();
      xhr.onload = () => {
        if (xhr.status !== 200) {
          reject(`unexpected HTTP error ${xhr.status} ${xhr.statusText} for URL ${location}`)
          return;
        }
        if (!xhr.response) {
          // This can happen for example when the response isn't an XML file.
          reject('no response received when fetching SVG');
          return;
        }
        resolve(xhr.response.rootElement);
      };
      xhr.onerror = () => {
        reject(`unknown error (status ${xhr.status}) while fetching ${location}`);
      };
    });
  }
  let svg = await requestCache[location];
  return svg.cloneNode(true);
}

// One independent part in the schematic. This might be a separate part like a
// LED, or it might be a board that itself also contains parts. Parts on a board
// are represented differently, though.
class Part {
  constructor(id, config, data, parent, schematic) {
    this.id = id;
    this.config = config;
    this.data = data;
    this.schematic = schematic;
    this.subparts = {};
    this.pins = {};
    this.parent = parent;
    this.tooltipPin = null;

    // Update data if needed.
    data.rotation = data.rotation || 0;
  }

  // Load the given part and return it (because constructor() can't be async).
  static async load(id, data, schematic) {
    let config = {};
    if (data.location) {
      // Config object is stored in an external JSON file. Need to load that
      // first.
      config = await loadJSON(new URL(data.location, schematic.simulator.baseURL));
    } else if (data.config) {
      // Config is stored directly in the (modifiable) data object.
      // For example, this may be a simple part created in the Add tab.
      config = data.config;
    }
    let part = new Part(id, config, data, null, schematic);
    if (part.config.svg) {
      await part.loadSVG();
    }
    return part;
  }

  // loadSVG loads the 'svg' property (this.svg) of this object.
  async loadSVG() {
    // Determine the SVG URL, which is relative to the board config JSON file.
    let svgUrl = new URL(this.config.svg, new URL('parts/', this.schematic.simulator.baseURL));

    let svg = await loadSVG(svgUrl);
    this.setRootElement(svg);
    this.width = this.rootElement.getAttribute('width');
    this.height = this.rootElement.getAttribute('height');
  }

  createSubParts() {
    this.subparts = {};
    for (let subconfig of this.config.parts || []) {
      let id = this.id + '.' + subconfig.id;
      let subpart = new Part(id, subconfig, {}, this, this.schematic);
      this.subparts[id] = subpart;
    }
  }

  // Create the container for the part SVG and initialize it.
  createElement(schematic) {
    this.container = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.container.setAttribute('class', 'board-container');

    // Add background rectangle.
    this.background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    this.background.classList.add('background');
    this.container.appendChild(this.background);

    // Add SVG to the schematic at the correct location.
    this.svgWrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svgWrapper.appendChild(this.rootElement);
    this.svgWrapper.setAttribute('class', 'board-wrapper');
    this.container.appendChild(this.svgWrapper);
    this.updatePosition();

    // Add some default styles.
    if (this.config.type === 'led' && this.config.color) {
      let [r, g, b] = this.config.color;
      this.rootElement.style.setProperty('--plastic', 'rgba(' + r/2 + ', ' + g/2 + ', ' + b/2 + ', 0.8)');
    }

    // Make the part draggable with a mouse.
    this.container.ondragstart = e => false;
    this.container.onmousedown = function(e) {
      if (newWire || newPart) {
        // Don't drag while in the process of adding a new wire.
        return;
      }
      if (e.button !== 0) {
        // Only handle button presses with the left button.
        return;
      }
      this.select();
      // Logical cursor position.
      let [cursorX, cursorY] = this.schematic.cursorPosition(e);
      partMovement = {
        part: this,
        initialCursorX: cursorX,
        initialCursorY: cursorY,
        initialPositionX: this.data.x,
        initialPositionY: this.data.y,
      };
    }.bind(this);

    // Make the part selectable.
    this.container.addEventListener('click', e => {
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
    let wireGroup = schematic.querySelector('.schematic-wires');
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
          newWire = new Wire(this.schematic, pin, null);
          newWire.updateFrom();
          newWire.updateToMovement(e.pageX, e.pageY);
          wireGroup.appendChild(newWire.line);
          this.schematic.simulator.root.classList.add('adding-wire');
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
          this.schematic.simulator.saveState();
          this.schematic.simulator.worker.postMessage({
            type: 'add',
            wires: [config],
          });
          newWire.select();
          newWire = null;
          this.schematic.simulator.root.classList.remove('adding-wire');
        }
      });

      // Show a tooltip when hovering over the pin.
      let pinTitle = el.dataset.title || pin.name;
      let removeTooltip = () => {
        this.tooltipPin = null;
        unhighlightConnection(pin.connected);
      }
      el.addEventListener('mouseenter', e => {
        this.tooltipPin = pin;
        highlightConnection(pin.connected);
        this.schematic.simulator.tooltip.create(pin, pinTitle, removeTooltip, () => {
          let dotRect = pin.dot.getBoundingClientRect();
          return [dotRect.y, dotRect.x + dotRect.width/2];
        });
      });
      el.addEventListener('mouseleave', () => {
        this.schematic.simulator.tooltip.remove(pin);
      });
    }

    // Detect click areas within the SVG file.
    // This is used for buttons and similar inputs.
    for (let el of this.rootElement.querySelectorAll('[data-clickarea]')) {
      let id = el.dataset.part ? this.id+'.'+el.dataset.part : this.id;
      let wasPressed = false;
      let setPressed = (pressed) => {
        if (pressed !== wasPressed) {
          if (this.schematic.simulator.root.classList.contains('adding-part')) {
            // Don't fire input events before the part has been fully added.
            return;
          }
          wasPressed = pressed;
          this.schematic.simulator.worker.postMessage({
            type: 'input',
            id: id,
            event: pressed ? 'press' : 'release',
          });
        }
      };
      el.addEventListener('mousedown', e => {
        setPressed(true);
      });
      el.addEventListener('mouseup', e => {
        setPressed(false);
      });
      el.addEventListener('mouseenter', e => {
        el.style.setProperty('--hover', '1');
      })
      el.addEventListener('mouseleave', e => {
        el.style.setProperty('--hover', '0');
        // This can sometimes happen when pressing and dragging. Without the
        // mouseleave event, the button would remain in the 'pressed' state.
        setPressed(false);
      });
    }

    return this.container;
  }

  setRootElement(el) {
    this.rootElement = el;
    this.leds = el.querySelectorAll('[data-type="rgbled"]');
    let canvas = el.querySelector('[data-type="canvas"]');
    if (canvas) {
      this.context = canvas.getContext('2d');
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

  // Set a new (x, y) position in millimeters, relative to the center.
  setPosition(x, y) {
    this.data.x = x;
    this.data.y = y;
    this.updatePosition();
    this.calculateWires();
    this.applyWires();
  }

  // Rotate the part by the given number of degrees, relative to the center.
  rotate(angle) {
    this.data.rotation = (this.data.rotation + angle) % 360;
    this.updatePosition();
    this.calculateWires();
    this.applyWires();
  }

  // Update position according to this.data.x and this.data.y.
  updatePosition() {
    // Set part position relative to the center of the schematic.
    // Do this using calc() so that it stays at the correct position when
    // resizing the window.
    let scale = this.schematic.scale;
    let translateX = this.schematic.translateX;
    let translateY = this.schematic.translateY;
    let r = this.data.rotation / 180 * Math.PI;
    let x = `calc(${this.data.x*scale}mm + ${this.width} * ${-Math.cos(r)/2*scale} + ${this.height} * ${Math.sin(r)/2*scale})`;
    let y = `calc(${this.data.y*scale}mm + ${this.width} * ${-Math.sin(r)/2*scale} + ${this.height} * ${(-Math.cos(r))/2*scale})`;
    this.container.style.transform = `translate(${translateX}mm, ${translateY}mm) translate(${x}, ${y}) rotate(${this.data.rotation}deg)`;
    this.svgWrapper.style.transform = `scale(${scale})`;
    this.background.style.width = `calc(${this.width} * ${scale})`;
    this.background.style.height = `calc(${this.height} * ${scale})`;
  }

  // Call calculateFrom and calculateTo as needed on the attached wires.
  // This will cause a reflow if needed, but doesn't change the DOM.
  calculateWires() {
    for (let pin of Object.values(this.pins)) {
      for (let wire of pin.wires) {
        if (wire.from === pin) {
          wire.calculateFrom();
        }
        if (wire.to === pin) {
          wire.calculateTo();
        }
      }
    }
  }

  // Call applyFrom and applyTo as needed on the attached wires.
  // This changes some properties, but does not itself force a reflow.
  applyWires() {
    for (let pin of Object.values(this.pins)) {
      for (let wire of pin.wires) {
        if (wire.from === pin) {
          wire.applyFrom();
        }
        if (wire.to === pin) {
          wire.applyTo();
        }
      }
    }
  }

  select() {
    if (selected) {
      selected.deselect();
    }
    this.container.classList.add('selected');
    selected = this;
  }

  deselect() {
    this.container.classList.remove('selected');
    selected = null;
  }

  // Remove the part everywhere, recursively, both in the UI and in the saved
  // state. Also create a message to be sent to the web worker to remove the
  // equivalent parts and wires there but don't send it yet: this is the job of
  // the caller.
  remove() {
    // If this is a part that's currently being added, cancel that.
    if (this === newPart) {
      newPart = null;
      this.schematic.simulator.root.classList.remove('adding-part');
    }

    // Remove all wires connected to this part.
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
    this.schematic.parts.delete(this.id);
    delete this.schematic.state.parts[this.id];
    message.parts.push(this.id);
    this.container.remove();

    // Remove a pin tooltip, if it is present.
    if (this.tooltipPin) {
      this.schematic.simulator.tooltip.remove(this.tooltipPin);
    }

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
    let schematicRect = this.part.schematic.simulator.schematicRect;
    let x = dotRect.x + dotRect.width/2 - schematicRect.x - schematicRect.width/2;
    let y = dotRect.y + dotRect.width/2 - schematicRect.y - schematicRect.height/2;
    return [x, y];
  }
}

// A wire is a manually drawn wire between two boards (or even between pins of
// the same board).
class Wire {
  constructor(schematic, from, to) {
    this.schematic = schematic;
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

  // Calculate coordinates of the 'from' side of the wire.
  calculateFrom() {
    [this.x1, this.y1] = this.from.getCoords();
  }

  // Apply coordinates previously calculated in calculateFrom().
  applyFrom() {
    this.line.setAttribute('x1', this.x1);
    this.line.setAttribute('y1', this.y1);
  }

  // Update based on the coordinates of the 'from' pin.
  updateFrom() {
    this.calculateFrom();
    this.applyFrom();
  }

  // Calculate coordinates of the 'to' side of the wire.
  calculateTo() {
    [this.x2, this.y2] = this.to.getCoords();
  }

  // Apply coordinates previously calculated in calculateTo().
  applyTo() {
    this.line.setAttribute('x2', this.x2);
    this.line.setAttribute('y2', this.y2);
  }

  // Update based on the coordinates of the 'to' pin.
  updateTo() {
    this.calculateTo();
    this.applyTo();
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
    let schematicRect = this.schematic.simulator.schematicRect;
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
      this.schematic.simulator.root.classList.remove('adding-wire');
    }

    // This connection might be highlighted right now. Make sure it is properly
    // un-highlighted.
    unhighlightConnection(this.from.connected);

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
let schematicPan = null;

document.addEventListener('mousemove', e => {
  if (partMovement) {
    let part = partMovement.part;
    let [cursorX, cursorY] = part.schematic.cursorPosition(e);
    let changeX = (cursorX - partMovement.initialCursorX) / part.schematic.scale;
    let changeY = (cursorY - partMovement.initialCursorY) / part.schematic.scale;
    part.setPosition(partMovement.initialPositionX+changeX, partMovement.initialPositionY+changeY);
  }
  if (newPart) {
    // Follow the mouse position.
    let schematic = newPart.schematic;
    let [cursorX, cursorY] = newPart.schematic.cursorPosition(e);
    let posX = (cursorX - schematic.translateX) / schematic.scale;
    let posY = (cursorY - schematic.translateY) / schematic.scale;
    newPart.setPosition(posX, posY);
  }
  if (newWire) {
    newWire.updateToMovement(e.pageX, e.pageY);
  }
  if (schematicPan) {
    let [cursorX, cursorY] = schematicPan.schematic.cursorPosition(e);
    let translateX = schematicPan.initialTranslateX + (cursorX - schematicPan.initialCursorX);
    let translateY = schematicPan.initialTranslateY + (cursorY - schematicPan.initialCursorY);
    schematicPan.schematic.moveTo(translateX, translateY);
  }
});

document.addEventListener('mouseup', e => {
  if (partMovement){
    partMovement.part.schematic.simulator.saveState();
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
  if ((e.key === 'Escape' || e.key == 'Delete') && newWire) {
    // Cancel the creation of a new wire.
    e.preventDefault();
    newWire.remove();
  } else if ((e.key === 'Escape' || e.key == 'Delete') && newPart) {
    // Cancel the creation of a new part.
    e.preventDefault();
    newPart.remove();
  } else if (e.key === 'Escape' && selected) {
    selected.deselect();
  } else if (e.key === 'Delete' && selected) {
    if (selected.id === 'main') {
      console.warn('not removing main part');
      return;
    }
    let simulator = selected.schematic.simulator;
    let message = selected.remove();
    selected = null;
    simulator.saveState();
    simulator.worker.postMessage(message);
  } else if (e.key.toLowerCase() === 'r' && selected) {
    selected.rotate(e.key === 'r' ? 45 : -45);
    selected.schematic.simulator.saveState();
  }
});

// Parse CSS unit, and return the value in millimeters.
function parseUnitMM(value) {
  if (value.endsWith('mm')) {
    return parseFloat(value.slice(0, -2));
  }
  throw `unknown value: ${value}`;
}

// Parse compiler errors from the Go (or TinyGo) compiler and convert them to an
// array of diagnostics ready to give to the editor.
function parseCompilerErrors(message) {
  let diagnostics = [];
  let re = new RegExp("^main\.go:([0-9]+)(:([0-9]+))?: (.*)$")
  let lines = message.split('\n');
  for (let line of lines) {
    let result = re.exec(line);
    if (result === null) {
      continue;
    }
    diagnostics.push({
      line: parseInt(result[1]),
      col: result[3] ? parseInt(result[3]) : 0,
      severity: 'error',
      message: result[4],
    })
  }
  return diagnostics;
}
