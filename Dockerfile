FROM golang:1.12-stretch AS build
RUN mkdir /build
COPY *.go /build/
WORKDIR /build
RUN go build -o main .

FROM golang:1.12-stretch
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache
RUN wget -O- https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
    echo "deb http://apt.llvm.org/stretch/ llvm-toolchain-stretch-8 main" >> /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends libxml2 clang-8
ADD release.tar.gz /app/
COPY --from=build /build/main /app/
COPY *.html *.css *.js *.json /app/frontend/
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main", "-dir=/app/frontend"]
EXPOSE 8080
