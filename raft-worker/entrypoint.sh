#!/bin/sh
set -eu

DATA_ROOT="${RAFT_DATA_ROOT:-/data}"
RAFT_HOME="${RAFT_HOME:-${DATA_ROOT}/raft}"
HOME_DIR="${HOME:-${DATA_ROOT}/home}"
WORKSPACE_DIR="${WORKSPACE_DIR:-${DATA_ROOT}/workspace}"

export RAFT_HOME
export SLOCK_HOME="${RAFT_HOME}"
export HOME="${HOME_DIR}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME_DIR}/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${HOME_DIR}/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME_DIR}/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME_DIR}/.local/state}"

mkdir -p \
  "${RAFT_HOME}" \
  "${HOME_DIR}" \
  "${XDG_CONFIG_HOME}" \
  "${XDG_CACHE_HOME}" \
  "${XDG_DATA_HOME}" \
  "${XDG_STATE_HOME}" \
  "${WORKSPACE_DIR}"

if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 "${DATA_ROOT}"
  exec setpriv --reuid=1000 --regid=1000 --clear-groups "$0" "$@"
fi

cd "${WORKSPACE_DIR}" 2>/dev/null || cd "${HOME_DIR}"

has_attachment() {
  servers_dir="${RAFT_HOME}/computer/servers"
  [ -d "${servers_dir}" ] || return 1
  find "${servers_dir}" -mindepth 2 -maxdepth 2 \( -name 'runner.state.json' -o -name 'attachment.json' \) 2>/dev/null | grep -q .
}

if [ "$#" -eq 0 ] || [ "$1" = "start" ]; then
  if has_attachment; then
    exec raft-computer start --foreground
  fi

  if [ -n "${RAFT_SERVER_SLUG:-}" ]; then
    if [ ! -f "${RAFT_HOME}/computer/user-session.json" ]; then
      echo "[raft-worker] No Raft user session found under ${RAFT_HOME}; starting device-code login..."
      if [ -n "${RAFT_SERVER_URL:-}" ]; then
        raft-computer login --server-url "${RAFT_SERVER_URL}"
      else
        raft-computer login
      fi
    fi

    echo "[raft-worker] Attaching computer to ${RAFT_SERVER_SLUG}..."
    set -- raft-computer attach "${RAFT_SERVER_SLUG}" --no-start
    if [ -n "${RAFT_SERVER_URL:-}" ]; then
      set -- "$@" --server-url "${RAFT_SERVER_URL}"
    fi
    if [ -n "${RAFT_COMPUTER_NAME:-}" ]; then
      set -- "$@" --name "${RAFT_COMPUTER_NAME}"
    fi
    "$@"

    exec raft-computer start --foreground
  fi

  echo "[raft-worker] Not attached yet and RAFT_SERVER_SLUG is unset."
  echo "[raft-worker] Either:"
  echo "  1) Set RAFT_SERVER_SLUG (and optional RAFT_SERVER_URL / RAFT_COMPUTER_NAME) and restart, then approve the device-code URL printed in logs; or"
  echo "  2) Upload an existing RAFT_HOME state directory into ${RAFT_HOME} via SFTP and restart."
  trap 'exit 0' TERM INT
  while :; do
    sleep 60 &
    wait $!
  done
fi

exec "$@"
