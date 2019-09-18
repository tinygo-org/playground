all: build

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
	gcloud builds submit --tag gcr.io/tinygo/playground
