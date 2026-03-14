#!/usr/bin/env node

// ── Library exports ────────────────────────────────────────────────

export {
  type ArkitekConfig,
  type ArkitekRelayEvents,
  type IncomingMessage,
  type MessageHandler,
  type ConnectionState,
  type ConnectedEvent,
  type PingEvent,
  type RespondPayload,
  type RespondResponse,
  type CouncilRequest,
  type CouncilResponse,
  type CouncilModelResponse,
  type ResolvedConfig,
  type OpenClawDetectedConfig,
  type CLIOptions,
} from "./types.js";

export { RelayClient } from "./relay.js";
export { maskKey, validateApiKey, checkTlsSafety, warnIfNotHttps } from "./validation.js";
export { queryCouncil } from "./council.js";
export { resolveConfig, rotateLogs } from "./config/resolver.js";
export {
  detectOpenClaw,
  findInstalledSkill,
  installSkillFile,
  getDefaultSkillsDir,
} from "./config/openclaw.js";

// ── Internal imports ───────────────────────────────────────────────

import {
  type ArkitekRelayEvents,
  type IncomingMessage,
  type MessageHandler,
  type CLIOptions,
  type ResolvedConfig,
  LOG_PREFIX,
} from "./types.js";
import { RelayClient } from "./relay.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { parseArgs, printHelp } from "./cli/parse.js";
import { runInstall } from "./cli/install.js";
import { runDoctor } from "./cli/doctor.js";
import { runStatus } from "./cli/status.js";
import { runLogs } from "./cli/logs.js";
import { runUninstall } from "./cli/uninstall.js";
import { runInitSkill } from "./cli/init-skill.js";
import { resolveConfig, isFirstRun, rotateLogs } from "./config/resolver.js";
import { testGatewayReachable } from "./config/openclaw.js";

// ── Public API ─────────────────────────────────────────────────────

const GATEWAY_TIMEOUT_MS = 120_000;

export function createArkitekRelay(
  config: { apiKey: string; autoReconnect?: boolean; baseUrl?: string },
  handler: MessageHandler,
  events?: ArkitekRelayEvents,
): RelayClient {
  return new RelayClient(config, handler, events);
}

// ── Gateway handler ────────────────────────────────────────────────

function validateGatewayUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported protocol "${parsed.protocol}" — only http:// and https:// are allowed`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid gateway URL "${url}": not a valid URL`);
    }
    throw err;
  }
}

function createGatewayHandler(
  gatewayUrl: string,
  gatewayToken?: string,
  agentId = "main",
): MessageHandler {
  validateGatewayUrl(gatewayUrl);
  const responsesUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/responses`;

  return async (message: IncomingMessage): Promise<string> => {
    console.log(
      `${LOG_PREFIX} [Gateway] Forwarding message ${message.messageId} to OpenClaw...`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-openclaw-agent-id": agentId,
    };
    if (gatewayToken) {
      headers["Authorization"] = `Bearer ${gatewayToken}`;
    }

    const body = JSON.stringify({
      model: "openclaw",
      input: message.content,
    });

    try {
      const resp = await fetch(responsesUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.error(
          `${LOG_PREFIX} [Gateway] OpenClaw returned HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
        );
        if (resp.status === 405) {
          return (
            `[Error] Agent gateway returned HTTP 405 (Method Not Allowed). ` +
            `The /v1/responses endpoint is likely disabled. ` +
            `Fix: openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true`
          );
        }
        return `[Error] Agent gateway returned HTTP ${resp.status}. Check your OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN.`;
      }

      const data = (await resp.json()) as {
        output?: {
          type?: string;
          content?: { type?: string; text?: string }[];
        }[];
      };

      const outputItem = data.output?.find(
        (item) => item.type === "message",
      );
      const textPart = outputItem?.content?.find(
        (part) => part.type === "output_text",
      );
      const reply = textPart?.text;

      if (!reply) {
        console.error(
          `${LOG_PREFIX} [Gateway] Unexpected response shape:`,
          JSON.stringify(data).slice(0, 300),
        );
        return "[Error] Agent returned an empty response.";
      }

      console.log(
        `${LOG_PREFIX} [Gateway] Got response (${reply.length} chars) for message ${message.messageId}`,
      );
      return reply;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG_PREFIX} [Gateway] Failed to reach OpenClaw: ${msg}`,
      );
      return `[Error] Could not reach the agent gateway at ${gatewayUrl}. Is your OpenClaw agent running?`;
    }
  };
}

// ── Relay startup ──────────────────────────────────────────────────

async function startRelay(cli: CLIOptions, installedAlready = false): Promise<void> {
  rotateLogs();
  let config = resolveConfig(cli);

  if (!config) {
    if (!installedAlready && process.stdin.isTTY) {
      console.log(
        `${LOG_PREFIX} No configuration found. Running guided setup...\n`,
      );
      await runInstall(cli);
      config = resolveConfig(cli);
    }
    if (!config) {
      console.error(
        `${LOG_PREFIX} ARKITEK_API_KEY not found. Run with --install or set the environment variable.`,
      );
      process.exit(1);
    }
  }

  await startRelayWithConfig(config);
}

async function startRelayWithConfig(config: ResolvedConfig): Promise<void> {
  let handler: MessageHandler;
  let mode: string;

  const reachable = await testGatewayReachable(config.gatewayUrl);

  if (reachable) {
    handler = createGatewayHandler(
      config.gatewayUrl,
      config.gatewayToken,
      config.agentId,
    );
    mode = "gateway";
    console.log(
      `${LOG_PREFIX} Mode: OpenClaw Gateway (${config.gatewayUrl}, agent: ${config.agentId})`,
    );
    if (config.source.gatewayUrl !== "default") {
      console.log(
        `${LOG_PREFIX} Gateway URL source: ${config.source.gatewayUrl}${config.source.gatewayToken ? `, token from ${config.source.gatewayToken}` : ""}`,
      );
    }
  } else {
    handler = async (message) => {
      console.log(
        `${LOG_PREFIX} [Echo] Received: ${message.content.slice(0, 100)}`,
      );
      return `Echo: ${message.content}`;
    };
    mode = "echo";
    console.log(
      `${LOG_PREFIX} Mode: Echo (gateway at ${config.gatewayUrl} not reachable)`,
    );
    console.log(
      `${LOG_PREFIX} Tip: Start OpenClaw (openclaw gateway start) then restart the relay.`,
    );
  }

  const relay = createArkitekRelay(
    {
      apiKey: config.arkitekApiKey,
      autoReconnect: config.autoReconnect,
      baseUrl: config.arkitekRelayUrl,
    },
    handler,
    {
      onConnect: (agentId) => {
        console.log(
          `${LOG_PREFIX} Connected! Agent ${agentId} is live and listening for messages.`,
        );
        if (mode === "gateway") {
          console.log(
            `${LOG_PREFIX} Messages from ArkiTek will be forwarded to OpenClaw.`,
          );
        }
      },
      onDisconnect: (reason) =>
        console.log(`${LOG_PREFIX} Disconnected: ${reason}`),
      onError: (err) =>
        console.error(`${LOG_PREFIX} Error: ${err.message}`),
    },
  );

  console.log(`${LOG_PREFIX} Connecting to ArkiTek...`);

  try {
    await relay.connect();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("invalid or revoked");

    if (isAuthError && process.stdin.isTTY) {
      console.log();
      console.log(
        `${LOG_PREFIX} Your API key was rejected by ArkiTek.`,
      );
      console.log(
        `${LOG_PREFIX} This usually means the key is expired, revoked, or from a different agent.`,
      );
      console.log();
      console.log(
        `${LOG_PREFIX} To fix this, run the setup wizard to enter a new key:`,
      );
      console.log(
        `${LOG_PREFIX}   npx arkitek-relay-skill --install`,
      );
      console.log();
      console.log(
        `${LOG_PREFIX} Or pass a key directly:`,
      );
      console.log(
        `${LOG_PREFIX}   npx arkitek-relay-skill --api-key <your_new_key>`,
      );
      console.log();

      if (config.source.arkitekApiKey !== "cli") {
        console.log(
          `${LOG_PREFIX} The rejected key came from: ${config.source.arkitekApiKey}`,
        );
        if (config.source.arkitekApiKey === "env") {
          console.log(
            `${LOG_PREFIX} Check your ARKITEK_API_KEY environment variable or .env files.`,
          );
        } else if (config.source.arkitekApiKey === "openclaw") {
          console.log(
            `${LOG_PREFIX} Check your OpenClaw config (~/.openclaw/openclaw.json).`,
          );
        } else if (config.source.arkitekApiKey === "persisted") {
          console.log(
            `${LOG_PREFIX} Run --install to update the saved key in ~/.arkitek-relay/config.json.`,
          );
        }
        console.log();
      }

      process.exit(1);
    }

    throw err;
  }

  console.log(
    `${LOG_PREFIX} Ready. Send a message from the ArkiTek UI to test.`,
  );
}

// ── CLI entry point ────────────────────────────────────────────────

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(process.argv[1]));

if (isMainModule) {
  (async () => {
    const cli = parseArgs(process.argv);

    switch (cli.command) {
      case "help":
        printHelp();
        break;
      case "install":
        await runInstall(cli);
        break;
      case "doctor":
        await runDoctor(cli);
        break;
      case "status":
        await runStatus();
        break;
      case "logs":
        await runLogs();
        break;
      case "uninstall":
        await runUninstall(cli);
        break;
      case "init-skill":
        await runInitSkill(cli);
        break;
      case "start":
      default: {
        const ranInstall = isFirstRun() && process.stdin.isTTY;
        if (ranInstall) {
          await runInstall(cli);
          console.log();
        }
        await startRelay(cli, ranInstall);
        break;
      }
    }
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("invalid or revoked");

    if (isAuthError) {
      console.error(`${LOG_PREFIX} ${msg}`);
    } else {
      console.error(`${LOG_PREFIX} Fatal:`, err);
    }
    process.exit(1);
  });
}
