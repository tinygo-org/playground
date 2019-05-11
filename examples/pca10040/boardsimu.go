// +build js,wasm

package main

import (
	"github.com/aykevl/boardsimu"
)

func init() {
	boardsimu.SetupDevice("pca10040")
}
