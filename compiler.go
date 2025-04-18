package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/ioutil"
	"log"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxCacheSize = 10 * 1000 * 1000 // 10MB
)

type compilerJob struct {
	Source       []byte      // source code of program to compile
	SourceHash   string      // sha256 of source (in hex form)
	Filename     string      // cache file path
	Compiler     string      // compiler to use for this job
	Target       string      // target board name, or "wasm"
	Format       string      // output format: "wasm", "hex", etc.
	ResultFile   chan string // filename on completion
	ResultErrors chan []byte // errors on completion
	Context      context.Context
}

// Started in the background, to limit the number of concurrent compiles.
func backgroundCompiler(ch chan compilerJob) {
	n := 0
	for job := range ch {
		n++
		err := job.Run()
		if err != nil {
			buf := &bytes.Buffer{}
			buf.WriteString(err.Error())
			job.ResultErrors <- buf.Bytes()
		}
		if n%100 == 1 {
			cleanupCompileCache()
		}
	}
}

// Run a single compiler job. It tries to load from the cache and kills the job
// (or even refuses to start) if this job was cancelled through the context.
func (job compilerJob) Run() error {
	outfileName := filepath.Base(job.Filename)

	// Attempt to load the file from the cache.
	_, err := os.Stat(job.Filename)
	if err == nil {
		// Cache hit!
		job.ResultFile <- job.Filename
		return nil
	}

	// Perhaps the job should not even be started.
	// Do a non-blocking read from the channel.
	select {
	case <-job.Context.Done():
		// Cancelled.
		return errors.New("aborted")
	default:
		// Not cancelled.
	}

	tmpfile := filepath.Join(cacheDir, "build-"+job.Compiler+"-"+job.Target+"-"+randomString(16)+".tmp."+job.Format)
	defer os.Remove(tmpfile)

	if bucket != nil {
		r, err := bucket.Object(outfileName).NewReader(job.Context)
		if err == nil {
			// File is already cached in the cloud.
			defer r.Close()

			// Copy the file (that is already cached in the cloud but not locally)
			// to the local cache.
			f, err := os.Create(tmpfile)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := io.Copy(f, r); err != nil {
				return err
			}

			if err := os.Rename(tmpfile, job.Filename); err != nil {
				return err
			}

			// Done. Return the file that is now cached locally.
			job.ResultFile <- job.Filename
			return nil
		}
	}

	// Cache miss, compile now.
	// But first write the Go source code to a file so it can be read by the
	// compiler.
	tmpdir, err := os.MkdirTemp("", "tinygo-playground-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpdir)
	for _, fn := range []string{"go.mod", "go.sum"} {
		data, err := os.ReadFile("tinygo-template/" + fn)
		if err != nil {
			return err
		}
		err = os.WriteFile(tmpdir+"/"+fn, data, 0o666)
		if err != nil {
			return err
		}
	}
	infile, err := os.Create(tmpdir + "/main.go")
	if err != nil {
		return err
	}
	if _, err := infile.Write([]byte("//line main.go:1:1\n")); err != nil {
		return err
	}
	if _, err := infile.Write(job.Source); err != nil {
		return err
	}

	var cmd *exec.Cmd
	env := []string{"GOPROXY=off"} // don't download dependencies
	switch job.Compiler {
	case "go":
		cmd = exec.Command("go", "build", "-json", "-trimpath", "-ldflags", "-s -w", "-o", tmpfile, infile.Name())
		env = append(env, "GOOS=wasip1", "GOARCH=wasm")
	case "tinygo":
		switch job.Format {
		case "wasm", "wasi":
			// simulate
			tag := strings.Replace(job.Target, "-", "_", -1) // '-' not allowed in tags, use '_' instead
			cmd = exec.Command("tinygo", "build", "-json", "-o", tmpfile, "-target", job.Format, "-tags", tag, "-no-debug", infile.Name())
		default:
			// build firmware
			cmd = exec.Command("tinygo", "build", "-json", "-o", tmpfile, "-target", job.Target, infile.Name())
		}
	}
	buf := &bytes.Buffer{}
	cmd.Stdout = buf
	cmd.Stderr = buf
	cmd.Dir = filepath.Dir(infile.Name()) // avoid long relative paths in error messages
	cmd.Env = append(os.Environ(), env...)
	finishedChan := make(chan struct{})
	func() {
		defer close(finishedChan)
		err := cmd.Run()
		if err != nil {
			if buf.Len() == 0 {
				buf.WriteString(err.Error())
			}
			job.ResultErrors <- stripFilename(buf.Bytes(), infile.Name())
			return
		}
		if err := os.Rename(tmpfile, job.Filename); err != nil {
			// unlikely
			buf.WriteString(err.Error())
			job.ResultErrors <- buf.Bytes()
			return
		}

		// Now copy the file over to cloud storage to cache across all
		// instances.
		if cacheType == cacheTypeGCS {
			obj := bucket.Object(outfileName)
			w := obj.NewWriter(job.Context)
			r, err := os.Open(job.Filename)
			if err != nil {
				log.Println(err.Error())
				return
			}
			defer r.Close()
			if _, err := io.Copy(w, r); err != nil {
				log.Println(err.Error())
				return
			}
			if err := w.Close(); err != nil {
				log.Println(err.Error())
				return
			}
		}

		// Done. Return the local file immediately.
		job.ResultFile <- job.Filename
	}()
	select {
	case <-finishedChan:
		// Job was completed before a cancellation.
	case <-job.Context.Done():
		// Job should be killed: it's useless now.
		cmd.Process.Kill()
	}
	return nil
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

var seededRand *rand.Rand = rand.New(rand.NewSource(time.Now().UnixNano()))

func randomString(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = chars[seededRand.Intn(len(chars))]
	}
	return string(b)
}

func stripFilename(buf []byte, filename string) []byte {
	prefix := []byte("# " + filename + "\n")
	if bytes.HasPrefix(buf, prefix) {
		buf = buf[len(prefix):]
	}
	return buf
}
