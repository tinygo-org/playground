'use strict';

// This file contains everything related to a project. At the moment, this only
// includes the source code to run on a particular board.

// A project is an encapsulation for a combination of source code, a board
// layout, and some state. After saving, it can be destroyed and re-loaded
// without losing data.
class Project {
  constructor(config, data) {
    this.config = config;
    this._data = data;
  }

  get created() {
    return this._data.created;
  }

  get humanName() {
    return this._data.humanName;
  }

  set humanName(humanName) {
    this._data.humanName = humanName;
  }

  get code() {
    return this._data.code;
  }

  get target() {
    return this.config.name;
  }

  get name() {
    return this._data.name || this.config.name;
  }

  // Save the project, if it was marked dirty.
  save(code) {
    if (!this._data.name) {
      // Project is saved for the first time.
      this._data.created = new Date();
      this._data.name = this.config.name + '-' + this._data.created.toISOString();
    }
    if (code === undefined) {
      throw 'no code provided';
    }
    this._data.code = code;
    let transaction = db.transaction(['projects'], 'readwrite');
    transaction.objectStore('projects').put(this._data).onsuccess = function(e) {
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
    let response = await fetch('parts/' + name + '.json');
    let config = await response.json();
    return new Project(config, {
      target: config.name,
      code: examples[config.example],
    });
  }
  return await new Promise((resolve, reject) => {
    let transaction = db.transaction(['projects'], 'readonly');
    transaction.objectStore('projects').get(name).onsuccess = async function(e) {
      if (e.target.result === undefined) {
        throw 'loadProject: project does not exist in DB';
      }
      let data = e.target.result;
      let response = await fetch('parts/' + data.target + '.json');
      let config = await response.json();
      resolve(new Project(config, data));
    };
  });
}
