package main

import (
	"bytes"
	"context"
	"io/ioutil"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
)

const (
	maxCacheSize = 10 * 1000 * 1000 // 10MB
)

type compilerJob struct {
	Source       []byte             // source code of program to compile
	SourceHash   string             // sha256 of source (in hex form)
	Target       string             // target board name, or "wasm"
	ResultFile   chan string        // filename on completion
	ResultErrors chan *bytes.Buffer // errors on completion
	Context      context.Context
}

// Started in the background, to limit the number of concurrent compiles.
func backgroundCompiler(ch chan compilerJob) {
	n := 0
	for job := range ch {
		n++
		job.Run()
		if n%100 == 1 {
			cleanupCompileCache()
		}
	}
}

// Run a single compiler job. It tries to load from the cache and kills the job
// (or even refuses to start) if this job was cancelled through the context.
func (job compilerJob) Run() {
	infile := filepath.Join(cacheDir, "build-"+job.Target+"-"+job.SourceHash+".go")
	outfile := filepath.Join(cacheDir, "build-"+job.Target+"-"+job.SourceHash+".wasm")

	// Attempt to load the file from the cache.
	_, err := os.Stat(outfile)
	if err == nil {
		// Cache hit!
		job.ResultFile <- outfile
		return
	}

	// Perhaps the job should not even be started.
	// Do a non-blocking read from the channel.
	select {
	case <-job.Context.Done():
		// Cancelled.
		buf := &bytes.Buffer{}
		buf.WriteString("aborted")
		job.ResultErrors <- buf
		return
	default:
		// Not cancelled.
	}

	// Cache miss, compile now.
	ioutil.WriteFile(infile, job.Source, 0400)
	cmd := exec.Command("tinygo", "build", "-o", outfile, "-tags", job.Target, "-no-debug", infile)
	buf := &bytes.Buffer{}
	cmd.Stdout = buf
	cmd.Stderr = buf
	finishedChan := make(chan struct{})
	func() {
		err := cmd.Run()
		if err != nil {
			buf.WriteString(err.Error())
			job.ResultErrors <- buf
		} else {
			job.ResultFile <- outfile
		}
		close(finishedChan)
	}()
	select {
	case <-finishedChan:
		// Job was completed before a cancellation.
	case <-job.Context.Done():
		// Job should be killed: it's useless now.
		cmd.Process.Kill()
	}
	os.Remove(infile)
}

// cleanupCompileCache is called regularly to clean up old compile results from
// the cache if the cache has grown too big.
func cleanupCompileCache() {
	totalSize := int64(0)
	files, err := ioutil.ReadDir(cacheDir)
	if err != nil {
		log.Println("could not read cache dir: ", err)
		return
	}
	for _, fi := range files {
		totalSize += fi.Size()
	}
	if totalSize > maxCacheSize {
		// Sort by modification time.
		sort.Slice(files, func(i, j int) bool {
			if files[i].ModTime().UnixNano() != files[j].ModTime().UnixNano() {
				return files[i].ModTime().UnixNano() < files[j].ModTime().UnixNano()
			}
			return files[i].Name() < files[j].Name()
		})

		// Remove all the oldest files.
		for totalSize > maxCacheSize {
			file := files[0]
			totalSize -= file.Size()
			err := os.Remove(filepath.Join(cacheDir, file.Name()))
			if err != nil {
				log.Println("failed to remove cache file:", err)
			}
			files = files[1:]
		}
	}
}
