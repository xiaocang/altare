import { ConfigError, loadConfig } from "./config.js";
import { createReadonlyRaftService } from "./raft.js";
import { createConnectorHttpServer } from "./server.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : "Invalid configuration.";
    process.stderr.write(`[raft-connector] startup error: ${message}\n`);
    process.exit(1);
  }

  const service = createReadonlyRaftService(config);
  const server = createConnectorHttpServer(config, service);

  server.listen(config.port, config.host, () => {
    const scope =
      config.channelScope.kind === "allowlist"
        ? `allowlist(${config.channelScope.channels.join(",")})`
        : "open";
    const auth = config.apiToken ? "bearer" : "unauthenticated";
    process.stdout.write(
      `[raft-connector] listening on http://${config.host}:${config.port} (mode=readonly, scope=${scope}, auth=${auth}, server=${config.serverUrl})\n`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
