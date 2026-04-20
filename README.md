# TinyGo Playground

Run small script and simulate firmware written in Go (using
[TinyGo](https://github.com/tinygo-org/tinygo)) in the browser, by compiling
to WebAssembly and optionally emulating common devices on these boards.

## How to run locally

If you have [TinyGo installed](https://tinygo.org/getting-started/), you can
easily run a local test server:

    $ go run .

Some changes need to be tested in the Docker container used in production. Run
`make run` to test such changes.

## Building the Docker container

You will need the `amd64` release build of TinyGo that you want to use to build the Docker container. Download it from Github for this release. Then copy it into the root directory of this repo and name it `release.tar.gz`

Now you should be able to run `make build`:

```
$ make build
docker build -t tinygo/playground:latest .
...
 => => naming to docker.io/tinygo/playground:latest
```

After the container has been built you can execute it using `make run`


## Deployment

### Playground web UI

When you merge to the `main` branch, the web UI will be deployed automatically using `Netlify` to the `play.tinygo.org` site.

### TinyGo compiler container

You must build the Docker container first before running this command.

```
make push-docker
```

### TinyGo compiler backend

You must install the `google-cloud-cli`

```
sudo snap install google-cloud-cli --classic
```

You must also authenticate to GCP:

```
gcloud init
```

Now you should be able to submit a job to build and deploy the container:

```
make push-gcloud
```

### TinyGo homepage/Tour

You must update the submodule in the `tinygo-site` repo and then deploy that in order to pickup changes to the playground.

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
