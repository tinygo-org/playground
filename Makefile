TINYGO_VERSION ?= 0.44.0

all: build

release.tar.gz:
	curl -fL -o release.tar.gz https://github.com/tinygo-org/tinygo/releases/download/v$(TINYGO_VERSION)/tinygo$(TINYGO_VERSION).linux-amd64.tar.gz

.PHONY: build
build: release.tar.gz
	docker build -t tinygo/playground:latest .

.PHONY: run
run: build stop
	docker run --rm -p 8080:8080 -t --name=playground tinygo/playground:latest ./main -dir=/app/frontend

.PHONY: stop
stop:
	docker rm -f playground || true

.PHONY: push-docker
push-docker:
	docker push tinygo/playground:latest

.PHONY: push-gcloud
push-gcloud: release.tar.gz
	gcloud builds submit --tag us-central1-docker.pkg.dev/tinygo/cloud-run-source-deploy/playground

# note: run `npm install` first
resources/editor.bundle.js: editor/editor.js editor/tango.js package.json package-lock.json Makefile
	npx rollup editor/editor.js -f es -o resources/editor.bundle.js -p @rollup/plugin-node-resolve

resources/editor.bundle.min.js: resources/editor.bundle.js
	npx terser --compress --mangle --output=resources/editor.bundle.min.js resources/editor.bundle.js
