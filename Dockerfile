FROM golang:1.12-stretch AS build
RUN mkdir /build
COPY *.go /build/
WORKDIR /build
RUN go build -o main .

FROM golang:1.12-stretch
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache
RUN apt-get update && apt-get install -y libxml2
ADD release.tar.gz /app/
COPY --from=build /build/main /app/
COPY *.html *.css *.js /app/
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main"]
EXPOSE 8080
