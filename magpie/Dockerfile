ARG BASE_IMAGE=ghcr.io/yetone/magpie:stable
FROM ${BASE_IMAGE}

ARG TARGETARCH
USER root

# Preinstall Antigravity CLI (agy) into /usr/local/bin so
# @magpie-community/opencode-agy-cli-auth uses it without downloading into /data.
RUN set -eu; \
    case "${TARGETARCH:-$(uname -m)}" in \
        amd64|x86_64) arch=amd64 ;; \
        arm64|aarch64) arch=arm64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac; \
    tmp=$(mktemp -d); \
    trap 'rm -rf "$tmp"' EXIT; \
    curl -fsSL "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_${arch}.json" -o "$tmp/manifest.json"; \
    meta=$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!/^https:\/\//.test(m.url || "") || !/^[0-9a-f]{128}$/i.test(m.sha512 || "")) process.exit(1); console.log(m.url + " " + m.sha512.toLowerCase());' "$tmp/manifest.json"); \
    url=${meta%% *}; \
    sha512=${meta#* }; \
    curl -fsSL "$url" -o "$tmp/payload"; \
    echo "${sha512}  $tmp/payload" | sha512sum -c -; \
    case "$url" in \
        *.tar.gz*) \
            tar -xzf "$tmp/payload" -C "$tmp" antigravity; \
            install -m 0755 "$tmp/antigravity" /usr/local/bin/agy \
            ;; \
        *) \
            install -m 0755 "$tmp/payload" /usr/local/bin/agy \
            ;; \
    esac

USER nonroot
RUN AGY_CLI_DISABLE_AUTO_UPDATE=true /usr/local/bin/agy --version
ENTRYPOINT ["/magpie"]
CMD ["serve"]
