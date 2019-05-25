FROM golang:latest AS build
RUN mkdir /build
ADD . /build/
WORKDIR /build
RUN tar -xf ./release.tar.gz
RUN go build -o main .

FROM golang:latest
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache
RUN apt-get update && apt-get install -y libxml2
USER appuser
COPY --from=build /build/main /app/
COPY --from=build /build/tinygo /app/tinygo
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main"]
EXPOSE 8080
