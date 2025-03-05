import { Simulator } from './simulator.js';
import { boards } from './boards.js';
import { Editor } from './resources/editor.bundle.min.js';

// This file controls the entire playground window, except for the output part
// on the right that is shared with the VS Code extension.

const API_URL = location.hostname == 'localhost' ? '/api' : 'https://playground-bttoqog3vq-uc.a.run.app/api';

var project = null;
var db = null;
const defaultProjectName = 'console';

let simulator = null;
let editor = null;

// updateBoards updates the dropdown menu. This must be done after loading the
// boards or updating the target selection.
async function updateBoards() {
  if (project) {
    let button = document.querySelector('#target > button');
    if (project.humanName) {
      button.textContent = project.humanName + ' ';
    } else if (project.created) {
      button.textContent = project.defaultHumanName + ' * ';
    } else {
      button.textContent = project.defaultHumanName + ' ';
    }
  }

  let projects = await getProjects();

  let dropdown = document.querySelector('#target > .dropdown-menu');
  dropdown.innerHTML = '';
  for (let name in boards) {
    let item = document.createElement('a');
    item.textContent = boards[name].humanName;
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
      let humanName = prompt('Project name', projectObj.humanName || projectObj.defaultHumanName);
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
        // Removing the currently active project.
        // Pick the base project using a bit of a hack (because we don't store
        // the original project name in the data object).
        let matches = project.parts[0].location.match(RegExp('^parts/([a-z0-9_-]+)\.json$'));
        if (matches) {
          // Found the project name, so use that.
          setProject(matches[1]);
        } else {
          // Fallback towards using the default name.
          setProject(defaultProjectName);
        }
      }
      db.transaction(['projects'], 'readwrite').objectStore('projects').delete(name);
      updateBoards();
    });
  }
}

// setProject updates the current project to the new project name.
async function setProject(name) {
  if (project && project.created) {
    saveProject(project, editor.text());
  }
  project = await loadProject(name);
  if (!project) {
    // Project not in the database, fall back on something working.
    project = await loadProject(defaultProjectName);
  }
  updateBoards();
  editor.setText(project.code);

  // Load simulator if not already done so (it must only happen once).
  if (!simulator) {
    let root = document.querySelector('#output');
    simulator = new Simulator({
      root: root,
      editor: editor,
      firmwareButton: document.querySelector('#btn-flash'),
      apiURL: API_URL,
      saveState: () => {
        saveProject(project);
        localStorage.tinygo_playground_projectName = project.name;
      },
    });
  }

  // Change to the new project state.
  await simulator.setState(project);

  // Load the same project on a reload.
  localStorage.tinygo_playground_projectName = name;
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


// Load a project based on a project name.
async function loadProject(name) {
  // New, clean project.
  if (name in boards) {
    let board = boards[name];
    return {
      name: name,
      defaultHumanName: board.humanName,
      code: board.code,
      compiler: board.compiler,
      parts: [
        {
          id: 'main',
          location: board.location,
          x: 0,
          y: 0,
        },
      ],
      wires: [],
    };
  }

  // Load existing project.
  return await new Promise((resolve, reject) => {
    let transaction = db.transaction(['projects'], 'readonly');
    transaction.objectStore('projects').get(name).onsuccess = async function(e) {
      if (e.target.result === undefined) {
        resolve(null); // project does not exist in DB
        return;
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
      resolve(data);
    };
  });
}

// Save the project to the database.
function saveProject(project, code) {
  if (!project.created) {
    // Project is saved for the first time.
    project.created = new Date();
    project.name = project.name + '-' + project.created.toISOString();
  }
  if (code) {
    project.code = code;
  }
  let transaction = db.transaction(['projects'], 'readwrite');
  transaction.objectStore('projects').put(project).onsuccess = function(e) {
    updateBoards();
  };
  transaction.onerror = function(e) {
    console.error('failed to save project:', e);
    e.stopPropagation();
  };
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
  // Create the editor.
  editor = new Editor(document.getElementById("editor"));

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
