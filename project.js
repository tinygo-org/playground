'use strict';

// This file contains everything related to a project. At the moment, this only
// includes the source code to run on a particular board.

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
      let mainPartConfig = await loadJSON(data.parts.main.location);
      if (!data.defaultHumanName) {
        // Upgrade old data format.
        data.defaultHumanName = mainPartConfig.humanName;
      }
      resolve(new Project(mainPartConfig, data));
    };
  });
}
