// File provided to easily update the go.mod and go.sum files.
// Update the dependencies once in a while and run `go mod tidy` for newer
// dependencies.

// This package also serves as a way to warm the cache while building the
// container.

package main

import (
	_ "tinygo.org/x/drivers"
	_ "tinygo.org/x/tinydraw"
	_ "tinygo.org/x/tinyfont"
	_ "tinygo.org/x/tinyfs"
	_ "tinygo.org/x/tinygl-font"
	_ "tinygo.org/x/tinyterm"

	_ "machine"
	_ "time"
)

func main() {
}
