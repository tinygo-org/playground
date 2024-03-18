# Build binary in the first stage.
FROM golang:1.22-bookworm AS build
RUN mkdir /build
COPY *.go go.mod go.sum /build/
WORKDIR /build
RUN go build -o main .

# Use a separate container for the resulting image.
FROM golang:1.22-bookworm
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
RUN cd /app/tinygo-template && go mod download

# Finish container.
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main", "-dir=/app/frontend", "-cache-type=gcs", "-bucket-name=tinygo-cache"]
EXPOSE 8080
