# Altare Docker Apps

Container images and Altare deployment notes for the 4-app setup:

| # | Altare App | Image | RAM / CPU / Disk | Role |
|---|---|---|---|---|
| 1 | `magpie` | `ghcr.io/xiaocang/magpie:stable` | 2 GB / 50% / 3.5 GB | Unified model gateway (Web UI + API, `/data` persisted, `agy` preinstalled) |
| 2 | `research-review` | `ghcr.io/xiaocang/raft-worker:v0.1.0` | 1.5 GB / 25% / 2 GB | Public research & light review Raft Computer worker |
| 3 | `verifier` | `ghcr.io/xiaocang/raft-worker:v0.1.0` | 1 GB / 25% / 1.5 GB | CI/version/hash/release-manifest verifier Raft Computer |
| 4 | `raft-readonly` | `ghcr.io/xiaocang/raft-connector:v0.1.0` | 1 GB / 25% / 1.5 GB | Read-only HTTP & MCP status/task connector for chatbots |

## Images

### 1. `magpie` (`ghcr.io/xiaocang/magpie:stable`)

Extends `ghcr.io/yetone/magpie:stable` with the Antigravity CLI (`/usr/local/bin/agy`) preinstalled for `@magpie-community/opencode-agy-cli-auth`, while preserving the upstream `nonroot` (`65532:65532`) user and `/magpie` entrypoint (no `setpriv`, which Altare's runtime disallows).

Altare configuration:
- **Port**: `39999` (internal-only via `.internal` private network; set `3430` only when exposing Web UI over HTTPS)
- **Data folder**: `/data`
- **Start command**: `web --addr 0.0.0.0:3430 --no-open`
- **Variables**:
  - `HOME=/data/home`
  - `XDG_CONFIG_HOME=/data`
  - `XDG_CACHE_HOME=/data/cache`
  - `XDG_DATA_HOME=/data/data`
  - `XDG_STATE_HOME=/data/state`
  - `MAGPIE_WEB_KEY=<strong-random-secret>`

### 2. `raft-worker` (`ghcr.io/xiaocang/raft-worker:v0.1.0`)

`node:24-bookworm-slim` with `raft-computer` (official native installer), `raft` CLI shim (`raft-computer __cli`), `git`, `gh`, `jq`, `ripgrep`, `python3`, `curl`, and `openssh-client`. Runs as `root` only long enough to `chown -R 1000:1000 /data`, then drops privileges to `1000:1000` (`node`).

Altare configuration (for `research-review` and `verifier`):
- **Port**: leave empty
- **Data folder**: `/data`
- **Variables**:
  - `RAFT_SERVER_SLUG=/<your-server-slug>`
  - `RAFT_SERVER_URL=https://<your-raft-server>`
  - `RAFT_COMPUTER_NAME=research-review` (or `verifier`)
  - Optional: `OPENAI_BASE_URL=http://magpie.internal:3425/v1`, `OPENAI_API_KEY=<magpie-gateway-key>` (or configure the gateway directly in Raft agent settings pointing to `http://magpie.internal:3425`)

On first boot without an attachment in `/data/raft`, check the Altare app logs (`altr logs research-review`) for the device-code login URL and approve it in your browser. Once attached, subsequent restarts run `raft-computer start --foreground` directly.

### 3. `raft-connector` (`ghcr.io/xiaocang/raft-connector:v0.1.0`)

Strictly read-only HTTP (`GET /v1/*`) and MCP (`POST /mcp`) bridge using `@botiverse/raft-sdk` (`identity.whoami`, `server.info`, `users.info`, `tasks.list`, `tasks.show`, `tasks.history`). Never calls message-body routes (`messages.*`, `inbox.*`) or any mutating/admin routes, and omits task `description` fields by default (`RAFT_INCLUDE_TASK_DESCRIPTIONS=1` to opt in).

Altare configuration (for `raft-readonly`):
- **Port**: `8080` (or leave empty if only queried via `http://raft-readonly.internal:8080`)
- **Variables**:
  - `RAFT_SERVER_URL=https://<your-raft-server>`
  - `RAFT_AGENT_CREDENTIAL=sk_agent_<readonly-token>`
  - `CONNECTOR_API_TOKEN=<bearer-token-for-chatbots>` (or `CONNECTOR_ALLOW_UNAUTHENTICATED=1` for private-network-only access)
  - Optional: `RAFT_ALLOWED_CHANNELS=#eng,#releases`

Endpoints:
- `GET /healthz`
- `GET /v1/status`
- `GET /v1/agents`
- `GET /v1/agents/:handle`
- `GET /v1/channels`
- `GET /v1/tasks?channel=%23eng` (or `?mine=true`)
- `GET /v1/tasks/:channel/:taskNumber`
- `GET /v1/tasks/:channel/:taskNumber/history`
- `POST /mcp` (JSON-RPC tools: `raft_status`, `raft_list_agents`, `raft_get_agent`, `raft_list_channels`, `raft_list_tasks`, `raft_get_task`, `raft_get_task_history`)
