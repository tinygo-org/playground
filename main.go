// Command playground runs a TinyGo compiler as an API that can be used from a
// web application.
package main

// This file implements the HTTP frontend.

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cloud.google.com/go/storage"
)

const (
	cacheTypeLocal = iota + 1 // Cache to a local directory
	cacheTypeGCS              // Google Cloud Storage
)

var (
	// The channel to submit compile jobs to.
	compilerChan chan compilerJob

	// The cache directory where cached wasm files are stored.
	cacheDir string

	// The cache type: local or Google Cloud Storage.
	cacheType int

	bucket *storage.BucketHandle

	firebaseCredentials string
)

func main() {
	// Create a build cache directory.
	userCacheDir, err := os.UserCacheDir()
	if err != nil {
		log.Fatalln("could not find temporary directory:", err)
	}
	cacheDir = filepath.Join(userCacheDir, "tinygo-playground")
	err = os.MkdirAll(cacheDir, 0777)
	if err != nil {
		log.Fatalln("could not create temporary directory:", err)
	}

	dir := flag.String("dir", ".", "which directory to serve from")
	cacheTypeFlag := flag.String("cache-type", "local", "cache type (local, gcs)")
	bucketNameFlag := flag.String("bucket-name", "", "Google Cloud Storage bucket name")
	flag.StringVar(&firebaseCredentials, "firebase-credentials", "", "path to JSON file with Firebase credentials")
	flag.Parse()

	switch *cacheTypeFlag {
	case "local":
		cacheType = cacheTypeLocal
	case "gcs":
		cacheType = cacheTypeGCS
		ctx := context.Background()
		client, err := storage.NewClient(ctx)
		if err != nil {
			log.Fatalln("could not create Google Cloud Storage client:", err)
		}
		bucket = client.Bucket(*bucketNameFlag)
	default:
		log.Fatalln("unrecognized cache type:", *cacheTypeFlag)
	}

	// Start the compiler goroutine in the background, that will serialize all
	// compile jobs.
	compilerChan = make(chan compilerJob)
	go backgroundCompiler(compilerChan)

	// Run the web server.
	http.HandleFunc("/api/compile", handleCompile)
	http.HandleFunc("/api/share", handleShare)
	http.HandleFunc("/api/stats", getStats)
	http.Handle("/", addHeaders(http.FileServer(http.Dir(*dir))))
	log.Print("Serving " + *dir + " on http://localhost:8080")
	http.ListenAndServe(":8080", nil)
}

func addHeaders(fs http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Add headers that enable greater accuracy of performance.now() in
		// Firefox.
		w.Header().Add("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Add("Cross-Origin-Embedder-Policy", "require-corp")

		fs.ServeHTTP(w, r)
	}
}

// handleCompile handles the /api/compile API endpoint. It first tries to serve
// from a cache and if that fails, compiles the submitted source code directly.
func handleCompile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "TinyGo-Page, TinyGo-Modified")

	var source []byte
	if strings.HasPrefix(r.Header.Get("Content-Type"), "text/plain") {
		// Read the source from the POST request.
		var err error
		source, err = ioutil.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
	} else {
		// Read the source from a form parameter.
		source = []byte(r.FormValue("code"))
	}
	// Hash the source code, used for the build cache.
	sourceHashRaw := sha256.Sum256([]byte(source))
	sourceHash := hex.EncodeToString(sourceHashRaw[:])

	// Check 'format' parameter.
	format := r.FormValue("format")
	if format == "" {
		// backwards compatibility (the format should be specified)
		format = "wasm"
	}
	flashFirmware := false
	switch format {
	case "wasm", "wasi":
		// Run code in the browser.
	case "elf", "hex", "uf2":
		// Build a firmware that can be flashed directly to a development board.
		flashFirmware = true
	default:
		// Unrecognized format. Disallow to be sure (might introduce security
		// issues otherwise).
		w.Write([]byte("unrecognized format"))
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// Check 'compiler' parameter.
	compiler := r.FormValue("compiler")
	if compiler == "" {
		compiler = "tinygo" // legacy fallback
	}
	switch compiler {
	case "go", "tinygo":
	default:
		// Unrecognized compiler.
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("unrecognized compiler"))
		return
	}

	// Track this compile action (after we're done compiling).
	defer trackCompile(map[string]any{
		"page":          r.Header.Get("TinyGo-Page"),
		"compiler":      compiler,
		"target":        r.FormValue("target"),
		"flashFirmware": flashFirmware,
		"timestamp":     time.Now().UTC().Truncate(time.Hour * 24),
	}, r.Header.Get("TinyGo-Modified"))

	// Attempt to serve directly from the directory with cached files.
	filename := filepath.Join(cacheDir, "build-"+compiler+"-"+r.FormValue("target")+"-"+sourceHash+"."+format)
	fp, err := os.Open(filename)
	if err == nil {
		// File was already cached! Serve it directly.
		defer fp.Close()
		sendCompiledResult(w, fp, format)
		return
	}

	// Create a new compiler job, which will be executed in a single goroutine
	// (to avoid overloading the system).
	job := compilerJob{
		Source:       source,
		SourceHash:   sourceHash,
		Filename:     filename,
		Compiler:     compiler,
		Target:       r.FormValue("target"),
		Format:       format,
		Context:      r.Context(),
		ResultFile:   make(chan string),
		ResultErrors: make(chan []byte),
	}
	// Send the job for execution.
	compilerChan <- job
	// See how well that went, when it finishes.
	select {
	case filename := <-job.ResultFile:
		// Succesful compilation.
		fp, err := os.Open(filename)
		if err != nil {
			log.Println("could not open compiled file:", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		defer fp.Close()
		sendCompiledResult(w, fp, format)
	case buf := <-job.ResultErrors:
		// Failed compilation.
		w.Write(buf)
	}
}

// sendCompiledResult streams a wasm file while gzipping it during transfer.
func sendCompiledResult(w http.ResponseWriter, fp *os.File, format string) {
	switch format {
	case "wasm", "wasi":
		w.Header().Set("Content-Type", "application/wasm")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=firmware."+format)
	}
	w.Header().Set("Content-Encoding", "gzip")
	gw := gzip.NewWriter(w)
	_, err := io.Copy(gw, fp)
	if err != nil {
		log.Println("could not read compiled file:", err)
		return
	}
	gw.Close()
}
