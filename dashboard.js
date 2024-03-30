import { Simulator } from './simulator.js';
import { examples, boardNames } from './boards.js';

// This file controls the entire playground window, except for the output part
// on the right that is shared with the VS Code extension.

const API_URL = location.hostname == 'localhost' ? '/api' : 'https://playground-bttoqog3vq-uc.a.run.app/api';

var project = null;
var db = null;
const defaultProjectName = 'console';

let simulator = null;

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
  project = await loadProject(name);
  updateBoards();
  let input = document.querySelector('#input');
  input.value = project.data.code;

  // Load simulator if not already done so (it must only happen once).
  if (!simulator) {
    let root = document.querySelector('#output');
    simulator = new Simulator({
      root: root,
      input: document.querySelector('#input'),
      firmwareButton: document.querySelector('#btn-flash'),
      apiURL: API_URL,
      saveState: () => {
        project.save();
        localStorage.tinygo_playground_projectName = project.name;
      },
    });
  }

  // Change to the new project state.
  await simulator.setState(project.data);

  // Load the same project on a reload.
  localStorage.tinygo_playground_projectName = name;

  // Enable the editor (it is diabled on first load).
  input.disabled = false;
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

// A project is an encapsulation for a combination of source code, a board
// layout, and some state. After saving, it can be destroyed and re-loaded
// without losing data.
class Project {
  constructor(mainPartConfig, data) {
    this.mainPartConfig = mainPartConfig;
    this.data = data;
  }

  get config() {
    return this.mainPartConfig;
  }

  get target() {
    return this.config.name;
  }

  get name() {
    return this.data.name || this.config.name;
  }

  // Save the project, if it was marked dirty.
  save(code) {
    if (!this.data.name) {
      // Project is saved for the first time.
      this.data.created = new Date();
      this.data.name = this.config.name + '-' + this.data.created.toISOString();
    }
    if (code) {
      this.data.code = code;
    }
    let transaction = db.transaction(['projects'], 'readwrite');
    transaction.objectStore('projects').put(this.data).onsuccess = function(e) {
      updateBoards();
    };
    transaction.onerror = function(e) {
      console.error('failed to save project:', e);
      e.stopPropagation();
    };
  }
}

// Load a project based on a project name.
async function loadProject(name) {
  if (name in boardNames) {
    let location = 'parts/'+name+'.json';
    let partConfig = await loadJSON(location);
    return new Project(partConfig, {
      defaultHumanName: partConfig.humanName,
      code: examples[partConfig.example],
      parts: {
        main: {
          location: location,
          x: 0,
          y: 0,
        },
      },
      wires: [],
    });
  }
  return await new Promise((resolve, reject) => {
    let transaction = db.transaction(['projects'], 'readonly');
    transaction.objectStore('projects').get(name).onsuccess = async function(e) {
      if (e.target.result === undefined) {
        reject('loadProject: project does not exist in DB');
      }
      let data = e.target.result;
      if (data.target) {
        // Upgrade old data format.
        data.parts = {
          main: {
            location: 'parts/'+data.target+'.json',
            x: 0,
            y: 0,
          },
        };
        delete data.target;
      }
      if (!data.wires) {
        data.wires = [];
      }
      let mainPartConfig = await loadJSON(data.parts.main.location);
      if (!data.defaultHumanName) {
        // Upgrade old data format.
        data.defaultHumanName = mainPartConfig.humanName;
      }
      resolve(new Project(mainPartConfig, data));
    };
  });
}

async function loadJSON(location) {
  let response = await fetch(location);
  return await response.json();
}

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
