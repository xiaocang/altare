import { statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHANNEL_TARGET_PATTERN = /^#[A-Za-z0-9._-]+$/;
const CREDENTIAL_PREFIX = "sk_agent_";
const PROFILE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_SERVER_URL = "https://api.raft.build";
const DEFAULT_PORT = 8080;

export type ChannelScope =
  | { kind: "open" }
  | { kind: "allowlist"; channels: string[] };

export type Config = {
  serverUrl: string;
  credential: string;
  channelScope: ChannelScope;
  apiToken: string | null;
  allowUnauthenticated: boolean;
  includeTaskDescriptions: boolean;
  host: string;
  port: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isRegularChannelTarget(value: string): boolean {
  return CHANNEL_TARGET_PATTERN.test(value);
}

export function normalizeChannelTarget(raw: string): string {
  const trimmed = raw.trim();
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!isRegularChannelTarget(normalized)) {
    throw new ConfigError(
      "Channel must be a regular #name target (DMs and thread targets are not supported).",
    );
  }
  return normalized;
}

export function redactSecrets(input: string, extraSecrets: readonly (string | null | undefined)[] = []): string {
  let out = input
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

function validateServerUrl(raw: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("RAFT_SERVER_URL must be a valid URL origin.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new ConfigError("RAFT_SERVER_URL must be an origin without path, query, fragment, or userinfo.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  const isInternal = hostname.endsWith(".internal");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (isLoopback || isInternal || allowInsecureHttp))) {
    throw new ConfigError(
      "RAFT_SERVER_URL must use https:// (http:// is allowed only for loopback, *.internal, or with RAFT_ALLOW_INSECURE_HTTP=1).",
    );
  }
  return parsed.origin;
}

function validateCredential(raw: string, sourceLabel: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CREDENTIAL_PREFIX) || trimmed.length <= CREDENTIAL_PREFIX.length) {
    throw new ConfigError(`${sourceLabel} must be an External Agent credential starting with ${CREDENTIAL_PREFIX}.`);
  }
  return trimmed;
}

function resolveRaftHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  if (env.RAFT_HOME?.trim()) return path.resolve(env.RAFT_HOME.trim());
  if (env.SLOCK_HOME?.trim()) return path.resolve(env.SLOCK_HOME.trim());
  return path.join(homeDir, ".raft");
}

function readCredentialFile(
  filePath: string,
  expectedServerUrl: string | undefined,
  allowInsecureHttp: boolean,
): { credential: string; serverUrl: string } {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    throw new ConfigError(`Credential file not found: ${filePath}`);
  }
  if (!st.isFile()) {
    throw new ConfigError(`Credential path is not a regular file: ${filePath}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ConfigError(`Credential file ${filePath} must have mode 0600 (no group/other permissions).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new ConfigError(`Credential file ${filePath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ConfigError(`Credential file ${filePath} must contain a JSON object.`);
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.credential !== "string") {
    throw new ConfigError(`Credential file ${filePath} is missing string field "credential".`);
  }
  const credential = validateCredential(rec.credential, `credential in ${filePath}`);
  const fileServerUrl =
    typeof rec.serverUrl === "string" && rec.serverUrl.trim()
      ? validateServerUrl(rec.serverUrl.trim(), allowInsecureHttp)
      : undefined;
  if (expectedServerUrl && fileServerUrl && expectedServerUrl !== fileServerUrl) {
    throw new ConfigError(
      `Credential file serverUrl (${fileServerUrl}) does not match RAFT_SERVER_URL (${expectedServerUrl}).`,
    );
  }
  const serverUrl = expectedServerUrl ?? fileServerUrl ?? DEFAULT_SERVER_URL;
  return { credential, serverUrl };
}

function parseChannelScope(raw: string | undefined): ChannelScope {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "*") {
    return { kind: "open" };
  }
  const channels: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!item) continue;
    if (!isRegularChannelTarget(item)) {
      throw new ConfigError(`Invalid channel in RAFT_ALLOWED_CHANNELS: ${item}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      channels.push(item);
    }
  }
  if (channels.length === 0) {
    return { kind: "open" };
  }
  return { kind: "allowlist", channels };
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_PORT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got ${raw}).`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): Config {
  const allowInsecureHttp = env.RAFT_ALLOW_INSECURE_HTTP === "1";
  const explicitServerUrl = env.RAFT_SERVER_URL?.trim()
    ? validateServerUrl(env.RAFT_SERVER_URL.trim(), allowInsecureHttp)
    : undefined;

  let credential: string;
  let serverUrl: string;

  if (env.RAFT_AGENT_CREDENTIAL?.trim()) {
    credential = validateCredential(env.RAFT_AGENT_CREDENTIAL, "RAFT_AGENT_CREDENTIAL");
    serverUrl = explicitServerUrl ?? DEFAULT_SERVER_URL;
  } else if (env.RAFT_CREDENTIAL_FILE?.trim()) {
    const resolved = readCredentialFile(
      path.resolve(env.RAFT_CREDENTIAL_FILE.trim()),
      explicitServerUrl,
      allowInsecureHttp,
    );
    credential = resolved.credential;
    serverUrl = resolved.serverUrl;
  } else if (env.RAFT_PROFILE?.trim() || env.RAFT_PROFILE_DIR?.trim()) {
    let filePath: string;
    if (env.RAFT_PROFILE_DIR?.trim()) {
      filePath = path.join(path.resolve(env.RAFT_PROFILE_DIR.trim()), "credential.json");
    } else {
      const slug = env.RAFT_PROFILE!.trim();
      if (!PROFILE_SLUG_PATTERN.test(slug)) {
        throw new ConfigError("RAFT_PROFILE must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.");
      }
      filePath = path.join(resolveRaftHome(env, homeDir), "profiles", slug, "credential.json");
    }
    const resolved = readCredentialFile(filePath, explicitServerUrl, allowInsecureHttp);
    credential = resolved.credential;
    serverUrl = resolved.serverUrl;
  } else {
    throw new ConfigError(
      "Missing Raft credential: set RAFT_AGENT_CREDENTIAL, RAFT_CREDENTIAL_FILE, or RAFT_PROFILE.",
    );
  }

  const allowUnauthenticated = env.CONNECTOR_ALLOW_UNAUTHENTICATED === "1";
  const apiToken = env.CONNECTOR_API_TOKEN?.trim() || null;
  if (!apiToken && !allowUnauthenticated) {
    throw new ConfigError(
      "CONNECTOR_API_TOKEN is required (or set CONNECTOR_ALLOW_UNAUTHENTICATED=1 for private-network-only access).",
    );
  }

  return {
    serverUrl,
    credential,
    channelScope: parseChannelScope(env.RAFT_ALLOWED_CHANNELS),
    apiToken,
    allowUnauthenticated,
    includeTaskDescriptions: env.RAFT_INCLUDE_TASK_DESCRIPTIONS === "1",
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePort(env.PORT ?? env.SERVER_PORT),
  };
}
