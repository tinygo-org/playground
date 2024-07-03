import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import {tags as t} from "@lezer/highlight"

// The Tango theme, based on:
// https://github.com/alecthomas/chroma/blob/master/styles/tango.xml
// But this theme in turn came from Pygments:
// https://github.com/pygments/pygments/blob/master/pygments/styles/tango.py
//
// There are a number of differences between the Chroma (and presumably
// Pygments) theme, and the CodeMirror theme here:
//
//   - Lezer (the CodeMirror parser) doesn't expose built-in functions (like
//     println) and types (like int), so they can't be themed. This is an
//     intentional design choice:
//     https://github.com/lezer-parser/go/issues/1
//   - Lezer doesn't distinguish between '=' and ':='. It also doesn't
//     distinguish between the address-taking operand '&' and the field operand
//     '.'.
//
// Overall I've tried to keep the semantic meaning of the highlighter the same
// as the original in Chroma (and Pygments):
//
//   - I use the bold orange color for operands that feel important: assignments
//     (both ':=' and '='), increment/decrement operators ('++', '--'), and
//     logic operators ('||', '&&').
//   - For all other operands and punctuation, I've picked a black bold style.

export const tangoHighlightStyle = HighlightStyle.define([
  {tag: t.keyword,
   color: "#204a87", // dark blue (bold)
   fontWeight: "bold"},
  {tag: t.comment,
   color: "#8f5902", // brown-ish orange
   fontStyle: "italic"},
  {tag: t.string,
   color: "#4e9a06"}, // light green
  {tag: t.number,
   color: "#0000cf", // bright blue
   fontWeight: "bold"},
  {tag: [t.paren, t.squareBracket, t.brace, t.punctuation, t.operator],
   fontWeight: "bold"}, // black
  {tag: [t.modifier, t.definitionOperator, t.updateOperator, t.logicOperator],
   color: "#ce5c00", // orange
   fontWeight: "bold"},
]);

export const tangoTheme = EditorView.theme({
  "&": {
    backgroundColor: "#f8f8f8",
  },
})

export const tango = [tangoTheme, syntaxHighlighting(tangoHighlightStyle)];
