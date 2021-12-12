'use strict';

// This file emulates a hardware board with an MCU and a set of external
// devices (LEDs etc.).


// Initial set of boards. It will be extended after boards.json has been loaded.
var boards = {
  console: {
    name: 'console',
    humanName: 'Console',
    example: 'hello',
    mainPart: 'console',
    parts: [
      {
        id: 'console',
        type: 'mcu',
        pins: [],
      }
    ],
  },
};

function removeBoard(boardContainer) {
  for (let child of boardContainer.children) {
    child.remove();
  }
}

// refreshParts redraws the SVG board from scratch
async function refreshParts(boardConfig) {
  return new Promise((resolve, reject) => {
    let boardContainer = document.querySelector('#schematic');
    if (!boardConfig.svg) {
      // Don't draw a board.
      // This is probably a regular (non-MCU) program.
      removeBoard(boardContainer);
      boardContainer.style.height = '0';
      resolve([]);
      return;
    }

    // Load the SVG file.
    // Doing this with XHR because XHR allows setting responseType while the
    // newer fetch API doesn't.
    let xhr = new XMLHttpRequest();
    xhr.open('GET', boardConfig.svg);
    xhr.responseType = 'document';
    xhr.send();
    xhr.onload = () => {
      removeBoard(boardContainer);

      // Add SVG to the existing SVG element (nested SVG).
      // Use a padding of 8px.
      let root = xhr.response.rootElement;
      root.classList.add('board')
      boardContainer.style.height = 'calc(' + root.getAttribute('height') + ' + 16px';
      boardContainer.appendChild(root);

      // Detect parts inside the SVG file. They have a tag like
      // data-part="led".
      let parts = {};
      for (let el of root.querySelectorAll('[data-part]')) {
        let part = {
          id: boardConfig.name+'.'+el.dataset.part,
          container: el,
          leds: el.querySelectorAll('[data-type="rgbled"]'),
        };
        if (el.nodeName === 'CANVAS') {
          part.context = el.getContext('2d');
        }
        parts[part.id] = part;
      }

      resolve(parts);
    };
  })
}

// updateParts updates all parts in the UI with the given updates coming from
// the web worker that's running the simulated program.
function updateParts(parts, updates) {
  for (let update of updates) {
    let part = parts[update.id];

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
    if (project.created) {
      if (project.projectHumanName) {
        button.textContent = project.projectHumanName + ' ';
      } else {
        button.textContent = project.config.humanName + ' * ';
      }
    } else {
      button.textContent = project.config.humanName + ' ';
    }
  }

  let projects = await getProjects();

  let dropdown = document.querySelector('#target > .dropdown-menu');
  dropdown.innerHTML = '';
  for (let name in boards) {
    let board = boards[name];
    let item = document.createElement('a');
    item.textContent = board.humanName;
    item.classList.add('dropdown-item');
    if (project && name == project.name) {
      item.classList.add('active');
    }
    item.setAttribute('href', '');
    item.dataset.name = name;
    dropdown.appendChild(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      let boardConfig = boards[item.dataset.name];
      setProject(boardConfig.name);
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
    let board = boards[projectObj.target];
    let item = document.createElement('a');
    item.innerHTML = '<span class="text"><span class="name"></span> – <i class="time"></i></span><span class="buttons"><button class="btn btn-light btn-sm edit-symbol rename" title="Rename">✎</button> <button class="btn btn-light btn-sm delete" title="Delete">🗑</button></span>';
    if (projectObj.humanName) {
      item.querySelector('.text').textContent = projectObj.humanName;
    } else {
      item.querySelector('.name').textContent = board.humanName;
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
      let humanName = prompt('Project name');

      if (project.name == name) {
        // Update name of current project.
        project.projectHumanName = humanName;
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
