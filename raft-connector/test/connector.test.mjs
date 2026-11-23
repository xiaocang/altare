import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { createReadonlyRaftService } from "../dist/raft.js";
import { createConnectorHttpServer } from "../dist/server.js";

function makeConfig(overrides = {}) {
  return {
    serverUrl: "https://raft.example.test",
    credential: "sk_agent_secret_token_value",
    channelScope: { kind: "open" },
    apiToken: "connector_test_token_123",
    allowUnauthenticated: false,
    includeTaskDescriptions: false,
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  };
}

function makeFakeClient(calls = []) {
  return {
    identity: {
      async whoami() {
        calls.push(["identity.whoami"]);
        return {
          ok: true,
          status: 200,
          data: {
            agent: { id: "ag_1", name: "readonly-bot", displayName: "Readonly Bot" },
            server: { id: "srv_1", slug: "main", name: "Main" },
            capabilities: ["read", "tasks"],
            guide: null,
            features: {},
          },
        };
      },
    },
    server: {
      async info(req) {
        calls.push(["server.info", req]);
        if (req?.view === "agents") {
          return {
            ok: true,
            state: "info",
            next: null,
            text: "",
            data: {
              view: "agents",
              server: {
                agents: [
                  { id: "ag_1", name: "research-review", status: "idle", role: "member" },
                  { id: "ag_2", name: "verifier", status: "working", role: "member" },
                ],
              },
              page: { offset: 0, limit: 50, total: 2, hasMore: false },
            },
          };
        }
        if (req?.view === "channels") {
          return {
            ok: true,
            state: "info",
            next: null,
            text: "",
            data: {
              view: "channels",
              server: {
                channels: [
                  { id: "ch_1", name: "engineering", visibility: "public" },
                  { id: "ch_2", name: "secret-admin", visibility: "private" },
                ],
              },
              page: { offset: 0, limit: 50, total: 2, hasMore: false },
            },
          };
        }
        return {
          ok: true,
          state: "info",
          next: null,
          text: "",
          data: {
            view: "summary",
            server: { counts: { agents: 2, channels: 2, humans: 1 } },
            page: null,
          },
        };
      },
    },
    users: {
      async info(req) {
        calls.push(["users.info", req]);
        return {
          ok: true,
          state: "info",
          next: null,
          text: "",
          data: {
            user: { kind: "agent", value: { id: "ag_1", name: req.name, status: "idle" } },
            memberships: [
              { id: "ch_1", name: "engineering", joined: true },
              { id: "ch_2", name: "secret-admin", joined: true },
            ],
            skippedChannels: 0,
            page: { offset: 0, limit: 50, total: 2, hasMore: false },
          },
        };
      },
    },
    tasks: {
      async list(req) {
        calls.push(["tasks.list", req]);
        return {
          ok: true,
          state: "board",
          next: null,
          text: "",
          data: {
            scope: req.mine ? "mine" : "channel",
            target: req.target ?? null,
            tasks: [
              {
                taskNumber: 12,
                title: "Verify release digest",
                status: "in_progress",
                description: "SECRET MESSAGE BODY SHOULD NOT LEAK BY DEFAULT",
                channelName: "engineering",
              },
              {
                taskNumber: 13,
                title: "Private admin task",
                status: "todo",
                description: "HIDDEN",
                channelName: "secret-admin",
              },
            ],
            coverage: null,
          },
        };
      },
      async show(req) {
        calls.push(["tasks.show", req]);
        return {
          ok: true,
          state: "task",
          next: null,
          text: "",
          data: {
            target: req.target,
            task: {
              taskNumber: req.taskNumber,
              title: "Verify release digest",
              status: "in_progress",
              description: "PRIVATE BODY",
            },
          },
        };
      },
      async history(req) {
        calls.push(["tasks.history", req]);
        return {
          ok: true,
          state: "history",
          next: null,
          text: "",
          data: {
            target: req.target,
            events: [{ kind: "status_changed", from: "todo", to: "in_progress" }],
          },
        };
      },
    },
  };
}

async function withServer(config, client, fn) {
  const service = createReadonlyRaftService(config, { client });
  const server = createConnectorHttpServer(config, service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("loadConfig enforces credential, auth token, and credential file permissions", () => {
  assert.throws(
    () => loadConfig({ RAFT_AGENT_CREDENTIAL: "sk_agent_abc" }, "/tmp"),
    /CONNECTOR_API_TOKEN is required/,
  );

  const cfg = loadConfig(
    {
      RAFT_AGENT_CREDENTIAL: "sk_agent_abc",
      RAFT_SERVER_URL: "https://raft.example.com",
      RAFT_ALLOWED_CHANNELS: "#eng, #ops",
      CONNECTOR_API_TOKEN: "tok_123",
    },
    "/tmp",
  );
  assert.equal(cfg.serverUrl, "https://raft.example.com");
  assert.deepEqual(cfg.channelScope, { kind: "allowlist", channels: ["#eng", "#ops"] });
  assert.equal(cfg.includeTaskDescriptions, false);

  const dir = mkdtempSync(path.join(os.tmpdir(), "raft-conn-test-"));
  try {
    const credPath = path.join(dir, "credential.json");
    writeFileSync(
      credPath,
      JSON.stringify({ credential: "sk_agent_file_1", serverUrl: "https://raft.example.com" }),
      "utf8",
    );
    chmodSync(credPath, 0o644);
    assert.throws(
      () =>
        loadConfig(
          {
            RAFT_CREDENTIAL_FILE: credPath,
            CONNECTOR_ALLOW_UNAUTHENTICATED: "1",
          },
          dir,
        ),
      /must have mode 0600/,
    );
    chmodSync(credPath, 0o600);
    const fromFile = loadConfig(
      {
        RAFT_CREDENTIAL_FILE: credPath,
        CONNECTOR_ALLOW_UNAUTHENTICATED: "1",
      },
      dir,
    );
    assert.equal(fromFile.credential, "sk_agent_file_1");
    assert.equal(fromFile.serverUrl, "https://raft.example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP server requires Bearer auth, keeps /healthz open, and rejects write methods", async () => {
  await withServer(makeConfig(), makeFakeClient(), async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.mode, "readonly");

    const unauth = await fetch(`${baseUrl}/v1/agents`);
    assert.equal(unauth.status, 401);

    const postV1 = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { authorization: "Bearer connector_test_token_123" },
    });
    assert.equal(postV1.status, 405);

    const agents = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: "Bearer connector_test_token_123" },
    });
    assert.equal(agents.status, 200);
    const agentsJson = await agents.json();
    assert.equal(agentsJson.agents.length, 2);
  });
});

test("allowlist filters channels and strips task descriptions by default", async () => {
  const config = makeConfig({
    channelScope: { kind: "allowlist", channels: ["#engineering"] },
  });
  await withServer(config, makeFakeClient(), async (baseUrl) => {
    const headers = { authorization: "Bearer connector_test_token_123" };

    const channels = await (await fetch(`${baseUrl}/v1/channels`, { headers })).json();
    assert.deepEqual(
      channels.channels.map((c) => c.name),
      ["engineering"],
    );

    const forbiddenTasks = await fetch(`${baseUrl}/v1/tasks?channel=%23secret-admin`, { headers });
    assert.equal(forbiddenTasks.status, 403);

    const dmTasks = await fetch(`${baseUrl}/v1/tasks?channel=dm%3A%40alice`, { headers });
    assert.equal(dmTasks.status, 400);

    const mineTasks = await (await fetch(`${baseUrl}/v1/tasks?mine=true`, { headers })).json();
    assert.equal(mineTasks.tasks.length, 1);
    assert.equal(mineTasks.tasks[0].taskNumber, 12);
    assert.equal("description" in mineTasks.tasks[0], false);

    const singleTask = await (await fetch(`${baseUrl}/v1/tasks/engineering/12`, { headers })).json();
    assert.equal(singleTask.task.title, "Verify release digest");
    assert.equal("description" in singleTask.task, false);

    const history = await (await fetch(`${baseUrl}/v1/tasks/engineering/12/history`, { headers })).json();
    assert.equal(history.events.length, 1);
  });
});

test("MCP endpoint lists only read-only tools and redacts secrets in upstream errors", async () => {
  const failingClient = {
    ...makeFakeClient(),
    server: {
      async info() {
        return {
          ok: false,
          error: {
            code: "HTTP_ERROR",
            status: 502,
            message: "upstream error with sk_agent_secret_token_value leaked",
          },
        };
      },
    },
  };
  await withServer(makeConfig(), failingClient, async (baseUrl) => {
    const headers = {
      authorization: "Bearer connector_test_token_123",
      "content-type": "application/json",
    };

    const listRes = await (
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json();
    const names = listRes.result.tools.map((t) => t.name);
    assert.deepEqual(names, [
      "raft_status",
      "raft_list_agents",
      "raft_get_agent",
      "raft_list_channels",
      "raft_list_tasks",
      "raft_get_task",
      "raft_get_task_history",
    ]);

    const callErr = await (
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "raft_list_agents", arguments: {} },
        }),
      })
    ).json();
    assert.equal(callErr.result.isError, true);
    assert.equal(callErr.result.content[0].text.includes("sk_agent_secret_token_value"), false);
    assert.equal(callErr.result.content[0].text.includes("sk_***"), true);
  });
});
