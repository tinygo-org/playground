# TinyGo Playground

Run small script and simulate firmware written in Go (using
[TinyGo](https://github.com/tinygo-org/tinygo)) in the browser, by compiling
to WebAssembly and optionally emulating common devices on these boards.

## How to run locally

If you have [TinyGo installed](https://tinygo.org/getting-started/), you can
easily run a local test server:

    $ go install
    $ playground

Some changes need to be tested in the Docker container used in production. Run
`make run` to test such changes.

## Architecture

The playground consists of a few separate parts:

  * The web UI, which is in index.html and dashboard.js/dashboard.css. It provides the editor and a dropdown to select the board to simulate. This web UI is only used on the fully featured playground ([play.tinygo.org](https://play.tinygo.org/)), it is not used on embedded playgrounds.
  * The simulator JavaScript module. It provides the DOM side of the playground: it manages the SVGs including drag and drop, applies updates from the running simulation, sends updates to the simulation, and allows adding new parts to the simulation such as new LEDs. You can find it in simulator.js. It lives in the browser main thread.
  * The simulator core. It tracks which pins/wires are connected together and form a single circuit. It also implements most simulated devices, such as LEDs and displays (for example, it acts as a SPI peripheral for the ST7789 display). It runs in a web worker to keep the web UI fast.
  * The runner. It actually downloads and runs the compiled code, and does very little other than that. It communicates with the simulator using message passing and a [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer). It runs in another web worker separate from the simulator core.
  * The compiler backend API. This is the server side that compiles code to be run in the browser or on a device. It is usable over a simple HTTP API.

## License

This project has been licensed under the BSD 3-clause license, just like the Go
and the TinyGo projects.
