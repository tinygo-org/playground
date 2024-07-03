import { EditorState, Compartment } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { indentUnit, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, keymap, EditorView } from '@codemirror/view';

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
}
