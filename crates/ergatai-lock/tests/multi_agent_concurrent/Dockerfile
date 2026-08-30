# Isolated test environment for multi-agent concurrent fanotify tests.
# Runs as root inside a container with its own mount namespace,
# so FAN_MARK_MOUNT only affects the container's filesystem.

FROM rust:1.96-slim

ARG HTTP_PROXY=http://host.docker.internal:7890
ARG HTTPS_PROXY=http://host.docker.internal:7890
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    libssl3 \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

ENV http_proxy=
ENV https_proxy=
ENV HTTP_PROXY=
ENV HTTPS_PROXY=

WORKDIR /app

CMD ["./multi_agent_concurrent", "--ignored", "--nocapture", "--test-threads=1"]
