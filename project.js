'use strict';

// This file contains everything related to a project. At the moment, this only
// includes the source code to run on a particular board.

// A project is an encapsulation for a combination of source code, a board
// layout, and some state. After saving, it can be destroyed and re-loaded
// without losing data.
class Project {
  constructor(parts, data) {
    this.parts = parts;
    this._data = data;
  }

  get config() {
    return this.parts.main.config;
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
    if (code) {
      this._data.code = code;
    }
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
    let part = await Part.load('main', {
      location: 'parts/'+name+'.json',
      x: 0,
      y: 0,
    });
    return new Project({main: part}, {
      defaultHumanName: part.config.humanName,
      code: examples[part.config.example],
      parts: {
        main: part.data,
      },
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
      let parts = await loadParts(data.parts);
      if (!data.defaultHumanName) {
        // Upgrade old data format.
        data.defaultHumanName = parts.main.config.humanName;
      }
      resolve(new Project(parts, data));
    };
  });
}
