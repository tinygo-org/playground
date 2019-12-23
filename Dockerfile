FROM golang:1.13-buster AS build
RUN mkdir /build
COPY *.go go.mod go.sum /build/
WORKDIR /build
RUN go build -o main .

FROM golang:1.13-buster
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache
ADD release.tar.gz /app/
COPY --from=build /build/main /app/
RUN go get tinygo.org/x/drivers
COPY *.html *.css *.js *.json /app/frontend/
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main", "-dir=/app/frontend", "-cache-type=gcs", "-bucket-name=tinygo-cache"]
EXPOSE 8080
