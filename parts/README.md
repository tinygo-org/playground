# Parts library

This directory contains a library of parts used in the simulator. In particular, it contains the SVG images that form the basis of the animated boards. These SVGs are loaded and some elements are modified to reflect state changes in the simulated circuit.

If you would like to add more boards, that would be great! However, please follow the style of the existing boards:

  * Small, well-documented SVG files are much preferred over long SVG files without any documentation. That means, it's much preferred to write them by hand than to make them in Inkscape. This not only makes reviewing easier, but also makes it easier to maintain/modify them in the future.
  * The SVG files should be viewable when opened standalone. Don't rely on CSS from simulator.css for example.
  * Write SVG paths using absolute numbers (`L`, `H`, `V`) instead of relative numbers (`l`, `h`, `v`). Again, this makes maintenance much easier.
  * If a component on a board consists of multiple SVG shapes, group them together in a `<g>` element and translate them first to the correct position using `translate(x, y)`.
  * Board images should be more symbolic than realistic looking. Not all components need to be on there, and certainly not all traces (if any). Include those that are important visually (to identify the board) and those relevant for simulation.
  * Keep shapes (such as LEDs) consistent across boards.
  * The unit of measurement is millimeters. All boards are set up with the viewBox matching the size in millimeters, so that 1px == 1mm. This is somewhat uncommon, but makes it a lot easier to write these board files. Hint: the usual pitch size is (exactly) 2.54mm, or fractions thereof.
  * The name of pins (`data-pin=`) should not change after creation, because existing (saved) schematics use those names to connect to.
