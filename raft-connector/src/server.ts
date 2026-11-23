import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { redactSecrets, type Config } from "./config.js";
import { ConnectorError, type ReadonlyRaftService } from "./raft.js";

const MAX_BODY_BYTES = 64 * 1024;
const VERSION = "0.1.0";

const taskStatusSchema = z.enum(["backlog", "todo", "in_progress", "in_review", "done", "closed", "all"]);

const MCP_TOOLS = [
  {
    name: "raft_status",
    description: "Read-only summary of the Raft server, agent identity, and counts (no message bodies).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "raft_list_agents",
    description: "List Raft agents and their current status (read-only).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive filter over agent name/description." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raft_get_agent",
    description: "Get one agent's status, role, description, and visible channel memberships (read-only).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent handle, e.g. @research-review or research-review." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "raft_list_channels",
    description: "List visible Raft channels (metadata only, no messages).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        joined: { type: "boolean" },
        archived: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raft_list_tasks",
    description: "List task progress on a #channel board (or mine=true) without reading channel messages.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Regular channel such as #engineering." },
        mine: { type: "boolean" },
        status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "closed", "all"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raft_get_task",
    description: "Get one task's current status and progress by channel and taskNumber (read-only).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        taskNumber: { type: "integer", minimum: 1 },
      },
      required: ["channel", "taskNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "raft_get_task_history",
    description: "Get a task's status change, claim, and assignment history (read-only).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        taskNumber: { type: "integer", minimum: 1 },
      },
      required: ["channel", "taskNumber"],
      additionalProperties: false,
    },
  },
] as const;

function isAuthorized(req: IncomingMessage, config: Config): boolean {
  if (!config.apiToken) {
    return config.allowUnauthenticated;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = header.slice("Bearer ".length).trim();
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(config.apiToken).digest(),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function parseOptionalInt(raw: string | null, name: string, min: number, max: number): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConnectorError("INVALID_REQUEST", `${name} must be an integer between ${min} and ${max}.`, 400);
  }
  return n;
}

function parseOptionalBool(raw: string | null, name: string): boolean | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConnectorError("INVALID_REQUEST", `${name} must be true or false.`, 400);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new ConnectorError("INVALID_REQUEST", "Request body too large.", 413);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnectorError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }
}

async function dispatchMcpTool(
  service: ReadonlyRaftService,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "raft_status":
      return service.getStatus();
    case "raft_list_agents":
      return service.listAgents(
        z
          .strictObject({
            query: z.string().optional(),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          })
          .parse(args),
      );
    case "raft_get_agent":
      return service.getAgent(
        z
          .strictObject({
            name: z.string().min(1),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          })
          .parse(args),
      );
    case "raft_list_channels":
      return service.listChannels(
        z
          .strictObject({
            query: z.string().optional(),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(200).optional(),
            joined: z.boolean().optional(),
            archived: z.boolean().optional(),
          })
          .parse(args),
      );
    case "raft_list_tasks":
      return service.listTasks(
        z
          .strictObject({
            channel: z.string().optional(),
            mine: z.boolean().optional(),
            status: taskStatusSchema.optional(),
          })
          .parse(args),
      );
    case "raft_get_task":
      return service.getTask(
        z
          .strictObject({
            channel: z.string().min(1),
            taskNumber: z.number().int().min(1),
          })
          .parse(args),
      );
    case "raft_get_task_history":
      return service.getTaskHistory(
        z
          .strictObject({
            channel: z.string().min(1),
            taskNumber: z.number().int().min(1),
          })
          .parse(args),
      );
    default:
      throw new ConnectorError("INVALID_REQUEST", `Unknown read-only tool: ${name}`, 404);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, service: ReadonlyRaftService): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST for MCP JSON-RPC requests." } });
    return;
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } });
    return;
  }
  const rpc = body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = rpc.id ?? null;

  if (rpc.method === "notifications/initialized") {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  if (rpc.method === "initialize") {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "raft-connector", version: VERSION },
      },
    });
    return;
  }
  if (rpc.method === "tools/list") {
    sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (rpc.method === "tools/call") {
    const toolName = typeof rpc.params?.name === "string" ? rpc.params.name : "";
    const toolArgs =
      rpc.params?.arguments && typeof rpc.params.arguments === "object" && !Array.isArray(rpc.params.arguments)
        ? (rpc.params.arguments as Record<string, unknown>)
        : {};
    try {
      const data = await dispatchMcpTool(service, toolName, toolArgs);
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
          isError: false,
        },
      });
    } catch (err) {
      const message =
        err instanceof ConnectorError
          ? err.message
          : err instanceof z.ZodError
            ? err.issues.map((i) => i.message).join("; ")
            : "Tool execution failed.";
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        },
      });
    }
    return;
  }
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${rpc.method ?? ""}` } });
}

export function createConnectorHttpServer(config: Config, service: ReadonlyRaftService): Server {
  const secrets = [config.credential, config.apiToken];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/healthz") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET only." } });
          return;
        }
        sendJson(res, 200, { ok: true, service: "raft-connector", version: VERSION, mode: "readonly" });
        return;
      }

      if (!isAuthorized(req, config)) {
        res.setHeader("www-authenticate", 'Bearer realm="raft-connector"');
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid Bearer token." } });
        return;
      }

      if (pathname === "/mcp") {
        await handleMcp(req, res, service);
        return;
      }

      if (!pathname.startsWith("/v1/")) {
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Unknown endpoint." } });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "raft-connector is strictly read-only (GET only)." },
        });
        return;
      }

      if (pathname === "/v1/status") {
        sendJson(res, 200, await service.getStatus());
        return;
      }

      if (pathname === "/v1/agents") {
        const data = await service.listAgents({
          query: url.searchParams.get("query") ?? undefined,
          offset: parseOptionalInt(url.searchParams.get("offset"), "offset", 0, 10_000),
          limit: parseOptionalInt(url.searchParams.get("limit"), "limit", 1, 200),
        });
        sendJson(res, 200, data);
        return;
      }

      const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(pathname);
      if (agentMatch) {
        const handle = decodeURIComponent(agentMatch[1]);
        const data = await service.getAgent({
          name: handle,
          offset: parseOptionalInt(url.searchParams.get("offset"), "offset", 0, 10_000),
          limit: parseOptionalInt(url.searchParams.get("limit"), "limit", 1, 200),
        });
        sendJson(res, 200, data);
        return;
      }

      if (pathname === "/v1/channels") {
        const data = await service.listChannels({
          query: url.searchParams.get("query") ?? undefined,
          offset: parseOptionalInt(url.searchParams.get("offset"), "offset", 0, 10_000),
          limit: parseOptionalInt(url.searchParams.get("limit"), "limit", 1, 200),
          joined: parseOptionalBool(url.searchParams.get("joined"), "joined"),
          archived: parseOptionalBool(url.searchParams.get("archived"), "archived"),
        });
        sendJson(res, 200, data);
        return;
      }

      if (pathname === "/v1/tasks") {
        const rawStatus = url.searchParams.get("status");
        const parsedStatus = rawStatus ? taskStatusSchema.safeParse(rawStatus) : null;
        if (parsedStatus && !parsedStatus.success) {
          throw new ConnectorError("INVALID_REQUEST", "Invalid status filter.", 400);
        }
        const data = await service.listTasks({
          channel: url.searchParams.get("channel") ?? undefined,
          mine: parseOptionalBool(url.searchParams.get("mine"), "mine"),
          status: parsedStatus?.success ? parsedStatus.data : undefined,
        });
        sendJson(res, 200, data);
        return;
      }

      const taskHistoryMatch = /^\/v1\/tasks\/([^/]+)\/(\d+)\/history$/.exec(pathname);
      if (taskHistoryMatch) {
        const channel = decodeURIComponent(taskHistoryMatch[1]);
        const taskNumber = Number(taskHistoryMatch[2]);
        sendJson(res, 200, await service.getTaskHistory({ channel, taskNumber }));
        return;
      }

      const taskMatch = /^\/v1\/tasks\/([^/]+)\/(\d+)$/.exec(pathname);
      if (taskMatch) {
        const channel = decodeURIComponent(taskMatch[1]);
        const taskNumber = Number(taskMatch[2]);
        sendJson(res, 200, await service.getTask({ channel, taskNumber }));
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Unknown endpoint." } });
    } catch (err) {
      if (err instanceof ConnectorError) {
        sendJson(res, err.httpStatus, {
          error: {
            code: err.code,
            message: redactSecrets(err.message, secrets),
            ...(err.serverCode ? { serverCode: err.serverCode } : {}),
          },
        });
        return;
      }
      sendJson(res, 500, {
        error: { code: "RAFT_INTERNAL_ERROR", message: "Unexpected connector error." },
      });
    }
  });
}
