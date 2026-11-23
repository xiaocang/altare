FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
      python3 \
      ripgrep \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN HOME=/root \
    RAFT_COMPUTER_INSTALL_DIR=/usr/local/bin \
    RAFT_COMPUTER_NON_INTERACTIVE=1 \
    sh -c 'curl -fsSL https://cdn.raft.build/computer/install.sh | sh' \
    && if [ ! -x /usr/local/bin/raft-computer ] && [ -x /root/.local/bin/raft-computer ]; then \
      cp -L /root/.local/bin/raft-computer /usr/local/bin/raft-computer; \
    fi \
    && chmod 0755 /usr/local/bin/raft-computer \
    && printf '#!/bin/sh\nexec /usr/local/bin/raft-computer __cli "$@"\n' > /usr/local/bin/raft \
    && chmod 0755 /usr/local/bin/raft \
    && rm -rf /root/.local /root/.raft /root/.slock \
    && /usr/local/bin/raft-computer --version \
    && /usr/local/bin/raft-computer __build-versions

COPY entrypoint.sh /usr/local/bin/raft-worker-entrypoint
RUN chmod 0755 /usr/local/bin/raft-worker-entrypoint

RUN mkdir -p /data/raft /data/home /data/workspace \
    && chown -R 1000:1000 /data

ENV HOME=/data/home \
    RAFT_HOME=/data/raft \
    SLOCK_HOME=/data/raft \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_CACHE_HOME=/data/home/.cache \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_STATE_HOME=/data/home/.local/state \
    WORKSPACE_DIR=/data/workspace

VOLUME /data
WORKDIR /data/workspace

ENTRYPOINT ["/usr/local/bin/raft-worker-entrypoint"]
CMD ["start"]
