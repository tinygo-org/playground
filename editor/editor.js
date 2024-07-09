import { EditorState, Compartment } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { indentUnit, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, keymap, EditorView } from '@codemirror/view';
import { lintGutter, setDiagnostics } from '@codemirror/lint';

import { oneDark } from "@codemirror/theme-one-dark";
import { tango } from "./tango.js";

import { go } from "@codemirror/lang-go";

// This is a CodeMirror 6 editor.
// The editor features are wrapped to provide a simpler interface for the
// simulator.
export class Editor {
  // Create a new editor, which will be added to the given parent.
  constructor(parent) {
    this.parent = parent;
    this.view = null;
    this.modifyCallback = () => {};
    this.parentStyles = getComputedStyle(parent);

    // Detect dark mode from theme changes.
    matchMedia('(prefers-color-scheme: dark)').onchange = () => {
      this.#setDarkMode(this.#getDarkMode());
    };

    // Detect dark mode from changes in the <html> attributes (e.g.
    // data-bs-theme="...").
    new MutationObserver(() => {
      this.#setDarkMode(this.#getDarkMode());
    }).observe(document.documentElement, {attributes: true});
  }

  // Set (or replace) the callback to call when the text in the editor changed.
  // The changed text can be obtained using the text() method.
  setModifyCallback(callback) {
    this.modifyCallback = callback;
  }

  // Return the current text in the editor.
  text() {
    if (!this.view) {
      throw 'editor was not set up yet (need to call setText() first?)';
    }
    return this.view.state.doc.toString();
  }

  // Replace the text in the editor. This resets the editor state entirely,
  // including the undo history.
  setText(text) {
    const editorState = this.#createEditorState(text, this.modifyCallback);

    // Create a new view, or if it already exists, replace the state in the view.
    if (!this.view) {
      this.view = new EditorView({
        state: editorState,
        parent: this.parent,
      });
    } else {
      this.view.setState(editorState);
    }

    // Clear the existing diagnostics.
    this.setDiagnostics([]);
  }

  #createEditorState(initialContents) {
    this.darkMode = this.#getDarkMode();

    this.themeConfig = new Compartment();
    let extensions = [
      EditorView.updateListener.of(update => {
        if (update.changedRanges.length) {
          this.modifyCallback();
        }
      }),
      lintGutter(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      indentUnit.of("\t"),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      go(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      this.themeConfig.of(this.#getDarkStyle(this.darkMode)),
    ];

    return EditorState.create({
      doc: initialContents,
      extensions
    });
  }

  // Get the array of extensions (with the theme) depending on whether we're
  // currently in dark mode or not.
  #getDarkStyle(dark) {
    return dark ? [oneDark] : [tango];
  }

  // Return whether the editor parent node is currently in a dark mode or not.
  #getDarkMode() {
    // Extract the 3 RGB numbers from styles.color.
    let parts = this.parentStyles.color.match(RegExp('\\d+', 'g'));
    // The following is a simplified version of the math found in here to
    // calculate whether styles.color is light or dark.
    // https://stackoverflow.com/questions/596216/formula-to-determine-perceived-brightness-of-rgb-color/56678483#56678483
    // Approximate linear sRGB.
    let r = Math.pow(parseInt(parts[0]) / 255, 2.2);
    let g = Math.pow(parseInt(parts[1]) / 255, 2.2);
    let b = Math.pow(parseInt(parts[2]) / 255, 2.2);
    // Calculate luminance (in linear sRGB space).
    let luminance = (0.2126*r + 0.7152*g + 0.0722*b);
    // Check whether text luminance is above the "middle grey" threshold of
    // 18.4% (which probably means there's light text on a dark background, aka
    // dark mode).
    let isDark = luminance > 0.184;
    return isDark;
  }

  // Update the editor with the given dark mode.
  #setDarkMode(dark) {
    if (dark !== this.darkMode) {
      this.darkMode = dark;
      this.view.dispatch({
        effects: this.themeConfig.reconfigure(this.#getDarkStyle(dark)),
      })
    }
  }

  // Set the current diagnostics in the editor.
  // The format is:
  //
  //   {
  //     line: ...,
  //     col: ...,
  //     message: "...",
  //     severity: "...",
  //   }
  setDiagnostics(diagnostics) {
    this.view.dispatch(setDiagnostics(this.view.state, this.#convertDiagnostics(diagnostics)));
  }

  // Convert diagnostics from line+column to index-based.
  #convertDiagnostics(diagnostics) {
    if (diagnostics.length === 0) {
      return [];
    }
    let result = [];
    // Iterate over all lines in the editor.
    // TODO: there's a race condition here. If the editor contents changed
    // between starting the compile and getting the results, some errors may be
    // at the wrong location.
    // In practice this might not happen because the compile is cancelled and
    // restarted when the editor changes.
    let lines = this.text().split('\n');
    let index = 0;
    let firstDiagnostic = 0;
    for (let linenum = 0; linenum < lines.length; linenum++) {
      let line = lines[linenum];
      for (let i=firstDiagnostic; i<diagnostics.length; i++) {
        let diag = diagnostics[i];
        if (diag.line > linenum+1) {
          break;
        }
        firstDiagnostic = i+1;

        // Convert line+col based diagnostic into index-based diagnostic.
        let from = index + diag.col - 1;
        let to   = index + diag.col - 1;
        if (diag.col <= 0) {
          from = index;
          to   = index + line.length;
        }
        result.push({
          from: from,
          to: to,
          severity: diag.severity,
          message: diag.message,
        })
      }
      index += line.length + 1;
    }
    return result;
  }
}
