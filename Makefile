all: build

.PHONY: build
build: release.tar.gz
	docker build -t tinygo/playground:latest .

.PHONY: run
run: build stop
	docker run --rm -p 8080:8080 -t --name=playground tinygo/playground:latest

.PHONY: stop
stop:
	docker rm -f playground || true

.PHONY: push
push:
	docker push tinygo/playground:latest

release.tar.gz: ../../tinygo-org/tinygo/build/release.tar.gz
	cp $^ $@
