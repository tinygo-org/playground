# TinyGo Playground

Run small script and simulate firmware written in Go (using
[TinyGo](https://github.com/tinygo-org/tinygo)) in the browser, by compiling
to WebAssembly and optionally emulating common devices on these boards.

## How to run locally

If you have [TinyGo installed](https://tinygo.org/getting-started/), you can
easily run a local test server:

    $ go install
    $ tinygo-play

Some changes need to be tested in the Docker container used in production. Run
`make run` to test such changes.

## License

This project has been licensed under the BSD 3-clause license, just like the Go
and the TinyGo projects.
