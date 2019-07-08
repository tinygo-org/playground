FROM golang:1.12-stretch AS build
RUN mkdir /build
COPY *.go /build/
WORKDIR /build
RUN go build -o main .
RUN go get tinygo.org/x/drivers

FROM golang:1.12-stretch
RUN adduser --disabled-login --system --home /app appuser
RUN mkdir -p /app/.cache && chown appuser /app/.cache
RUN wget -O- https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
    echo "deb http://apt.llvm.org/stretch/ llvm-toolchain-stretch-8 main" >> /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends libxml2 clang-8
RUN curl -O https://static.dev.sifive.com/dev-tools/riscv64-unknown-elf-gcc-8.2.0-2019.05.3-x86_64-linux-ubuntu14.tar.gz && \
    tar -C /usr/local --strip-components=1 -xf riscv64-unknown-elf-gcc-8.2.0-2019.05.3-x86_64-linux-ubuntu14.tar.gz && \
    rm riscv64-unknown-elf-gcc-8.2.0-2019.05.3-x86_64-linux-ubuntu14.tar.gz
ADD release.tar.gz /app/
COPY --from=build /build/main /app/
COPY --from=build /go/src/tinygo.org/ /go/src/tinygo.org/
COPY *.html *.css *.js *.json /app/frontend/
USER appuser
ENV PATH="${PATH}:/app/tinygo/bin"
WORKDIR /app
CMD ["./main", "-dir=/app/frontend"]
EXPOSE 8080
