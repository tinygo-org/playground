'use strict';

// This file contains everything related to a project. At the moment, this only
// includes the source code to run on a particular board.

// A project is an encapsulation for a combination of source code, a board
// layout, and some state. After saving, it can be destroyed and re-loaded
// without losing data.
class Project {
  constructor(data) {
    this.created = data.created; // both a timestamp and the database key (undefined if not in the DB)
    this.target = data.target;
    this.mustBeSaved = false;
    this.board = new Board(boards[this.target], document.querySelector('#devices'));
  }

  // Set the board state as modified, so that it will be saved the next time
  // save() is called.
  markModified() {
    this.mustBeSaved = true;
    if (!this.created) {
      // Project is modified for the first time.
      this.created = new Date();
      this.save();
      updateResetButton();
    }
  }

  // Save the project, if it was marked dirty.
  save() {
    if (!this.created)
      return;
    if (!this.mustBeSaved)
      return;
    this.mustBeSaved = false;
    let code = document.querySelector('#input').value;
    let transaction = db.transaction(['projects'], 'readwrite');
    transaction.objectStore('projects').put({
      target: this.target,
      created: this.created,
      code: code,
    });
    transaction.onerror = function(e) {
      console.error('failed to save project:', e);
      e.stopPropagation();
    };
  }

  // Delete this project. After this, the project object should not generally be
  // re-used.
  delete() {
    if (!this.created) return;
    let transaction = db.transaction(['projects'], 'readwrite');
    transaction.objectStore('projects').delete(this.created);
    this.created = undefined;
  }
}

// Load a project based on a target name. In the future, multiple saved projects
// may exist at the same time.
function loadProject(target) {
  return new Promise((resolve, reject) => {
    let transaction = db.transaction(['projects'], 'readonly');
    let input = document.querySelector('#input');
    input.textContent = '';
    input.disabled = true;
    transaction.objectStore('projects').index('target').get(target).onsuccess = function(e) {
      if (e.target.result === undefined) {
        // Project data does not exist. Create a new project.
        project = new Project({
          target: target,
        });
        input.value = examples[project.board.config.example];
      } else {
        project = new Project({
          target: target,
          created: e.target.result.created,
        });
        input.value = e.target.result.code;
      }
      resolve();
      input.disabled = false;
    };
  });
}
