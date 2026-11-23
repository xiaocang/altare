import {
  createRaft,
  type CreateRaftOptions,
  type ListTasksRequest,
  type Raft,
  type ServerInfoRequest,
  type TaskRef,
  type UserInfoRequest,
} from "@botiverse/raft-sdk";
import { normalizeChannelTarget, redactSecrets, type Config } from "./config.js";

const MAX_DIAGNOSTIC_LENGTH = 400;

export type ConnectorErrorCode =
  | "CHANNEL_NOT_ALLOWED"
  | "INVALID_REQUEST"
  | "RAFT_UPSTREAM_ERROR"
  | "RAFT_INTERNAL_ERROR";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly httpStatus: number;
  readonly serverCode?: string;

  constructor(code: ConnectorErrorCode, message: string, httpStatus: number, serverCode?: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.serverCode = serverCode;
  }
}

export type ReadonlyRaftClient = Pick<Raft, "identity" | "server" | "users" | "tasks">;

export type ListAgentsInput = {
  query?: string;
  offset?: number;
  limit?: number;
};

export type GetAgentInput = {
  name: string;
  offset?: number;
  limit?: number;
};

export type ListChannelsInput = {
  query?: string;
  offset?: number;
  limit?: number;
  joined?: boolean;
  archived?: boolean;
};

export type ListTasksInput = {
  channel?: string;
  mine?: boolean;
  status?: ListTasksRequest["status"];
};

export type GetTaskInput = {
  channel: string;
  taskNumber: number;
};

export type ReadonlyRaftService = {
  getStatus(): Promise<Record<string, unknown>>;
  listAgents(input?: ListAgentsInput): Promise<Record<string, unknown>>;
  getAgent(input: GetAgentInput): Promise<Record<string, unknown>>;
  listChannels(input?: ListChannelsInput): Promise<Record<string, unknown>>;
  listTasks(input: ListTasksInput): Promise<Record<string, unknown>>;
  getTask(input: GetTaskInput): Promise<Record<string, unknown>>;
  getTaskHistory(input: GetTaskInput): Promise<Record<string, unknown>>;
};

function clampErrorText(raw: string, secrets: readonly (string | null | undefined)[]): string {
  const redacted = redactSecrets(raw, secrets).replace(/\s+/g, " ").trim();
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function mapFailure(
  err: { code?: string; message?: string; status?: number; serverCode?: string } | undefined,
  secrets: readonly (string | null | undefined)[],
): ConnectorError {
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 502;
  const msg = clampErrorText(err?.message || "Upstream Raft request failed.", secrets);
  const code: ConnectorErrorCode = err?.code === "INVALID_REQUEST" ? "INVALID_REQUEST" : "RAFT_UPSTREAM_ERROR";
  return new ConnectorError(code, msg, code === "INVALID_REQUEST" ? 400 : status, err?.serverCode);
}

function assertChannelAllowed(config: Config, rawChannel: string): string {
  let target: string;
  try {
    target = normalizeChannelTarget(rawChannel);
  } catch (err) {
    throw new ConnectorError(
      "CHANNEL_NOT_ALLOWED",
      err instanceof Error ? err.message : "Invalid channel target.",
      400,
    );
  }
  if (config.channelScope.kind === "allowlist" && !config.channelScope.channels.includes(target)) {
    throw new ConnectorError("CHANNEL_NOT_ALLOWED", `Channel ${target} is not in RAFT_ALLOWED_CHANNELS.`, 403);
  }
  return target;
}

function sanitizeTask(task: Record<string, unknown>, includeDescriptions: boolean): Record<string, unknown> {
  if (includeDescriptions) {
    return task;
  }
  const { description: _omitted, ...rest } = task;
  return rest;
}

function filterAllowedChannels<T extends { name?: string | null }>(config: Config, channels: readonly T[]): T[] {
  if (config.channelScope.kind === "open") {
    return [...channels];
  }
  const allowed = new Set(config.channelScope.channels);
  return channels.filter((ch) => {
    if (!ch.name) return false;
    const normalized = ch.name.startsWith("#") ? ch.name : `#${ch.name}`;
    return allowed.has(normalized);
  });
}

export function createReadonlyRaftService(
  config: Config,
  deps: {
    client?: ReadonlyRaftClient;
    fetch?: CreateRaftOptions["fetch"];
  } = {},
): ReadonlyRaftService {
  const secrets = [config.credential, config.apiToken];
  const client: ReadonlyRaftClient =
    deps.client ??
    createRaft({
      serverUrl: config.serverUrl,
      credential: config.credential,
      fetch: deps.fetch,
      retry: { attempts: 2 },
    });

  return {
    async getStatus() {
      const [whoami, summary] = await Promise.all([
        client.identity.whoami(),
        client.server.info({ view: "summary" }),
      ]);
      if (!whoami.ok) {
        throw mapFailure(whoami.error, secrets);
      }
      if (!summary.ok) {
        throw mapFailure(summary.error, secrets);
      }
      return {
        mode: "readonly",
        agent: whoami.data.agent,
        server: whoami.data.server,
        capabilities: whoami.data.capabilities,
        features: whoami.data.features,
        summary: summary.data.server,
      };
    },

    async listAgents(input = {}) {
      const req: ServerInfoRequest = {
        view: "agents",
        query: input.query,
        offset: input.offset,
        limit: input.limit,
      };
      const outcome = await client.server.info(req);
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      const serverData = outcome.data.server as unknown as Record<string, unknown>;
      return {
        agents: serverData.agents ?? [],
        page: outcome.data.page,
      };
    },

    async getAgent(input) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new ConnectorError("INVALID_REQUEST", "Agent handle is required.", 400);
      }
      const req: UserInfoRequest = {
        name: trimmed,
        offset: input.offset,
        limit: input.limit,
      };
      const outcome = await client.users.info(req);
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      return {
        user: outcome.data.user,
        memberships: filterAllowedChannels(config, outcome.data.memberships),
        skippedChannels: outcome.data.skippedChannels,
        page: outcome.data.page,
      };
    },

    async listChannels(input = {}) {
      const req: ServerInfoRequest = {
        view: "channels",
        query: input.query,
        offset: input.offset,
        limit: input.limit,
        joined: input.joined,
        archived: input.archived,
      };
      const outcome = await client.server.info(req);
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      const serverData = outcome.data.server as unknown as { channels?: Array<{ name?: string | null }> };
      return {
        channels: filterAllowedChannels(config, serverData.channels ?? []),
        page: outcome.data.page,
      };
    },

    async listTasks(input) {
      const hasChannel = Boolean(input.channel?.trim());
      const useMine = Boolean(input.mine);
      if (hasChannel === useMine) {
        throw new ConnectorError(
          "INVALID_REQUEST",
          "Specify exactly one of channel (#name) or mine=true.",
          400,
        );
      }
      let target: string | undefined;
      if (hasChannel) {
        target = assertChannelAllowed(config, input.channel!);
      }
      const outcome = await client.tasks.list({
        ...(target ? { target } : { mine: true }),
        ...(input.status ? { status: input.status } : {}),
      });
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      const tasks = outcome.data.tasks.map((task) =>
        sanitizeTask(task as unknown as Record<string, unknown>, config.includeTaskDescriptions),
      );
      const filteredTasks =
        config.channelScope.kind === "allowlist" && useMine
          ? tasks.filter((task) => {
              const ch = typeof task.channelName === "string" ? task.channelName : typeof task.target === "string" ? task.target : null;
              if (!ch) return false;
              const norm = ch.startsWith("#") ? ch : `#${ch}`;
              return config.channelScope.kind === "allowlist" && config.channelScope.channels.includes(norm);
            })
          : tasks;

      return {
        scope: outcome.data.scope,
        target: outcome.data.target,
        tasks: filteredTasks,
        coverage: outcome.data.coverage,
        pagination: outcome.data.pagination ?? null,
      };
    },

    async getTask(input) {
      const target = assertChannelAllowed(config, input.channel);
      if (!Number.isInteger(input.taskNumber) || input.taskNumber < 1) {
        throw new ConnectorError("INVALID_REQUEST", "taskNumber must be a positive integer.", 400);
      }
      const req: TaskRef = { target, taskNumber: input.taskNumber };
      const outcome = await client.tasks.show(req);
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      return {
        target: outcome.data.target,
        task: sanitizeTask(
          outcome.data.task as unknown as Record<string, unknown>,
          config.includeTaskDescriptions,
        ),
      };
    },

    async getTaskHistory(input) {
      const target = assertChannelAllowed(config, input.channel);
      if (!Number.isInteger(input.taskNumber) || input.taskNumber < 1) {
        throw new ConnectorError("INVALID_REQUEST", "taskNumber must be a positive integer.", 400);
      }
      const req: TaskRef = { target, taskNumber: input.taskNumber };
      const outcome = await client.tasks.history(req);
      if (!outcome.ok) {
        throw mapFailure(outcome.error, secrets);
      }
      return outcome.data as unknown as Record<string, unknown>;
    },
  };
}
