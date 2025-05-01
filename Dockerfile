# Build binary in the first stage.
FROM golang:1.24-bookworm AS build
RUN mkdir /build
COPY *.go go.mod go.sum /build/
WORKDIR /build
RUN go build -o main .

# Use a separate container for the resulting image.
FROM golang:1.24-bookworm
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache

# Copy TinyGo
ADD release.tar.gz /app/

# Copy built binary (in the first stage container).
COPY --from=build /build/main /app/

# Copy resources.
COPY *.html *.css *.js *.json /app/frontend/
COPY resources /app/frontend/resources
COPY parts /app/frontend/parts
COPY worker /app/frontend/worker
COPY tinygo-template /app/tinygo-template

# Make sure all dependencies are downloaded.
WORKDIR /app/tinygo-template
RUN go mod download

# Warm the cache.
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
RUN GOOS=wasip1 GOARCH=wasm go build -o /tmp/outfile && \
    tinygo build -o /tmp/outfile -target=wasi && \
    tinygo build -o /tmp/outfile -target=wasm && \
    tinygo build -o /tmp/outfile -target=arduino && \
    tinygo build -o /tmp/outfile -target=arduino-nano33 && \
    tinygo build -o /tmp/outfile -target=circuitplay-bluefruit && \
    tinygo build -o /tmp/outfile -target=circuitplay-express && \
    tinygo build -o /tmp/outfile -target=gopher-badge && \
    tinygo build -o /tmp/outfile -target=hifive1b && \
    tinygo build -o /tmp/outfile -target=microbit && \
    tinygo build -o /tmp/outfile -target=pinetime && \
    tinygo build -o /tmp/outfile -target=reelboard && \
    rm /tmp/outfile

# Finish container.
WORKDIR /app
CMD ["./main", "-dir=/app/frontend", "-cache-type=gcs", "-bucket-name=tinygo-cache"]
EXPOSE 8080
