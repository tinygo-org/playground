'use strict';

// This file contains everything related to a project. At the moment, this only
// includes the source code to run on a particular board.

// A project is an encapsulation for a combination of source code, a board
// layout, and some state. After saving, it can be destroyed and re-loaded
// without losing data.
class Project {
  constructor(data) {
    this._data = data;
    this.name = data.name; // may be undefined
    this.target = data.target || data.name;
    this.created = data.created;
    this.mustBeSaved = false;
  }

  get config() {
    return boards[this.target];
  }

  get board() {
    throw 'todo: board';
  }

  get projectHumanName() {
    if (this.created) {
      return this._data.humanName;
    }
    return undefined; // no project name available
  }

  set projectHumanName(humanName) {
    if (!this.created)
      throw 'trying to set project human name of non-created project';
    this._data.humanName = humanName;
  }

  get code() {
    if (this.name in boards) {
      return examples[this.config.example];
    }
    return this._data.code;
  }

  // Set the board state as modified, so that it will be saved the next time
  // save() is called.
  markModified(code) {
    this.mustBeSaved = true;
    if (!this.created) {
      // Project is modified for the first time.
      this.created = new Date();
      this.name = this.config.name + '-' + (new Date()).toISOString();
      // this._data was a board config before. Replace it with a real object
      // before calling save() to avoid inconsistencies.
      this._data = {
        name: this.name,
        target: this.target,
        created: this.created,
        code: code,
      };
      this.save(code);
    }
  }

  // Save the project, if it was marked dirty.
  save(code) {
    if (!this.created)
      return;
    if (!this.mustBeSaved)
      return;
    if (code === undefined) {
      throw 'no code provided';
    }
    this.mustBeSaved = false;
    let transaction = db.transaction(['projects'], 'readwrite');
    this._data = {
      name: this.name,
      target: this.target,
      created: this.created,
      humanName: this.projectHumanName,
      code: code,
    };
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
  if (name in boards) {
    return new Project(boards[name]);
  }
  return await new Promise((resolve, reject) => {
    let transaction = db.transaction(['projects'], 'readonly');
    transaction.objectStore('projects').get(name).onsuccess = function(e) {
      if (e.target.result === undefined) {
        throw 'loadProject: project does not exist in DB';
      }
      resolve(new Project(e.target.result));
    };
  });
}
