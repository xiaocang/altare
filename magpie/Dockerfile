ARG BASE_IMAGE=ghcr.io/yetone/magpie:stable
FROM ${BASE_IMAGE}

USER root

ENTRYPOINT ["/bin/sh", "-c", "set -e; mkdir -p /config/magpie /config/cache/magpie /config/home /config/data /config/state; if [ \"$(id -u)\" = \"0\" ]; then chown -R 65532:65532 /config; exec setpriv --reuid=65532 --regid=65532 --clear-groups /magpie \"$@\"; fi; exec /magpie \"$@\"", "--"]
CMD ["serve"]
