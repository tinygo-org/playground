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

// refreshParts recreates the div that contains all parts.
function refreshParts(boardConfig, boardContainer) {
  boardContainer.innerHTML = '';
  let parts = {};
  for (let config of boardConfig.parts) {
    if (!config.shape) {
      // Assume no shape property means the part doesn't need to be created.
      continue;
    }

    let part = {id: boardConfig.name+'.'+config.id};
    parts[part.id] = part;

    part.container = document.createElement('div');
    part.container.classList.add('part');
    part.container.innerHTML = '<div class="part-content"></div><div class="part-name"></div>';
    part.container.querySelector('.part-name').textContent = config.humanName;
    boardContainer.appendChild(part.container);
    let content = part.container.querySelector('.part-content');
    if (config.shape === 'led') {
      // A typical LED. Currently in the shape of a 5mm through-hole LED.
      content.innerHTML = '<div class="led"></div>'
    } else if (config.shape == 'ledstrip') {
      // Like a typical WS2812 LED strip.
      content.innerHTML = '<div class="ledstrip"><div class="ledstrip-leds"></div></div>'
      let ledContainer = content.querySelector('.ledstrip-leds');
      part.leds = [];
      for (let i=0; i<config.length; i++) {
        let led = document.createElement('div');
        led.classList.add('ledstrip-led');
        ledContainer.appendChild(led);
        part.leds.push(led);
      }
    } else if (config.shape === 'display') {
      // Screens like ST7789 or e-paper displays.
      content.innerHTML = '<canvas class="display"></canvas>';
      let canvas = content.querySelector('canvas');
      let rotation = config.rotation || 0;
      if (rotation % 180 === 0) {
        canvas.width = config.width;
        canvas.height = config.height;
      } else {
        canvas.width = config.height;
        canvas.height = config.width;
      }
      part.context = canvas.getContext('2d');
      if (rotation !== 0) {
        if (rotation == 90) {
          part.context.translate(canvas.width, 0);
          part.context.rotate(Math.PI * 0.5);
        } else if (rotation == 180) {
          part.context.translate(canvas.width, canvas.height);
          part.context.rotate(Math.PI * 1.0);
        } else if (rotation == 270) {
          part.context.translate(0, canvas.height);
          part.context.rotate(Math.PI * 1.5);
        } else {
          console.warn('unknown rotation for ' + config.id + ':', rotation);
        }
      }
    } else {
      console.warn('unknown part shape:', config.shape);
      continue;
    }
  }

  return parts;
}

// updateParts updates all parts in the UI with the given updates coming from
// the web worker that's running the simulated program.
function updateParts(parts, updates) {
  for (let update of updates) {
    let part = parts[update.id];

    // LED strips, like typical WS2812 strips.
    // They are stored as sequential RGB values.
    if (update.ledstrip) {
      for (let i=0; i<part.leds.length; i++) {
        // Extract colors from the array.
        let r = update.ledstrip[i*3+0];
        let g = update.ledstrip[i*3+1];
        let b = update.ledstrip[i*3+2];
        let color = 'rgb(' + r + ',' + g + ',' + b + ')';
        part.leds[i].style.background = color;
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
// store. It returns an empty list when the database hasn't been initialized
// yet.
async function getProjects() {
  // Load all projects.
  if (!db) {
    return [];
  }
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

function loadBoards() {
  fetch('boards.json').then((response) => {
    response.json().then((data) => {
      Object.assign(boards, data);
      updateBoards();
    });
  }).catch((reason) => {
    // TODO
    console.error(reason);
  });
}
