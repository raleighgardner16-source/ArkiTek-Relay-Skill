#!/usr/bin/env node

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
} from "./types.js";

export { RelayClient } from "./relay.js";
export { maskKey, validateApiKey, checkTlsSafety, warnIfNotHttps } from "./validation.js";
export { queryCouncil } from "./council.js";

import {
  type ArkitekConfig,
  type ArkitekRelayEvents,
  type MessageHandler,
  type ConnectionState,
  LOG_PREFIX,
  API_KEY_PATTERN,
} from "./types.js";
import { RelayClient } from "./relay.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

export function createArkitekRelay(
  config: ArkitekConfig,
  handler: MessageHandler,
  events?: ArkitekRelayEvents
): RelayClient {
  return new RelayClient(config, handler, events);
}

function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function promptForKey(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question("  Paste your API key here: ", (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

function saveKeyToEnv(apiKey: string): void {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf-8");
    if (content.includes("ARKITEK_API_KEY=")) {
      content = content.replace(/ARKITEK_API_KEY=.*/, `ARKITEK_API_KEY=${apiKey}`);
    } else {
      content = content.trimEnd() + `\nARKITEK_API_KEY=${apiKey}\n`;
    }
    writeFileSync(envPath, content);
  } else {
    writeFileSync(
      envPath,
      `ARKITEK_API_KEY=${apiKey}\nARKITEK_AUTO_RECONNECT=true\n`
    );
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  (async () => {
    loadEnvFile();

    let apiKey = process.env.ARKITEK_API_KEY;

    if (!apiKey) {
      if (!process.stdin.isTTY) {
        console.error(`${LOG_PREFIX} ARKITEK_API_KEY environment variable is required`);
        process.exit(1);
      }

      console.log(`\n${LOG_PREFIX} Welcome! Let's connect your agent to ArkiTek.\n`);
      console.log("  1. Go to https://arkitek.dev");
      console.log("  2. Navigate to Agents → Add Agent → Create");
      console.log("  3. Copy the API key (starts with ak_)\n");

      apiKey = await promptForKey();

      if (!apiKey) {
        console.error(`\n${LOG_PREFIX} No key provided. Exiting.`);
        process.exit(1);
      }

      if (!API_KEY_PATTERN.test(apiKey)) {
        console.error(`\n${LOG_PREFIX} Invalid key format. Keys start with ak_ and are 67 characters.`);
        process.exit(1);
      }

      saveKeyToEnv(apiKey);
      process.env.ARKITEK_API_KEY = apiKey;
      console.log(`\n${LOG_PREFIX} API key saved to .env — you won't need to enter it again.`);
    }

    const autoReconnect = process.env.ARKITEK_AUTO_RECONNECT !== "false";

    const echoHandler: MessageHandler = async (message) => {
      console.log(`${LOG_PREFIX} [Echo] Received: ${message.content.slice(0, 100)}`);
      return `Echo: ${message.content}`;
    };

    const relay = createArkitekRelay(
      { apiKey, autoReconnect },
      echoHandler,
      {
        onConnect: (agentId) =>
          console.log(`${LOG_PREFIX} Connected! Agent ${agentId} is live and listening for messages.`),
        onDisconnect: (reason) =>
          console.log(`${LOG_PREFIX} Disconnected: ${reason}`),
        onError: (err) =>
          console.error(`${LOG_PREFIX} Error: ${err.message}`),
      }
    );

    console.log(`${LOG_PREFIX} Connecting to ArkiTek...`);
    await relay.connect();
    console.log(`${LOG_PREFIX} Ready. Send a message from the ArkiTek UI to test.`);
  })().catch((err: unknown) => {
    console.error(`${LOG_PREFIX} Fatal:`, err);
    process.exit(1);
  });
}
