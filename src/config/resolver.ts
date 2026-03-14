import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CLIOptions,
  ConfigSource,
  PersistedConfig,
  ResolvedConfig,
} from "../types.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_GATEWAY_URL,
  RELAY_CONFIG_DIR,
  RELAY_CONFIG_FILE,
  PERSISTED_CONFIG_VERSION,
  LOG_PREFIX,
  LOG_ROTATE_MAX_BYTES,
  LOG_ROTATE_KEEP,
} from "../types.js";
import { detectOpenClaw } from "./openclaw.js";

// ── Path helpers ───────────────────────────────────────────────────

export function getConfigDir(): string {
  return join(homedir(), RELAY_CONFIG_DIR);
}

export function getConfigPath(): string {
  return join(getConfigDir(), RELAY_CONFIG_FILE);
}

export function getLogPath(): string {
  return join(getConfigDir(), "relay.log");
}

export function getErrorLogPath(): string {
  return join(getConfigDir(), "relay-error.log");
}

// ── Log rotation ────────────────────────────────────────────────────

function rotateFile(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    if (size < LOG_ROTATE_MAX_BYTES) return;

    for (let i = LOG_ROTATE_KEEP; i >= 1; i--) {
      const older = `${filePath}.${i}`;
      if (i === LOG_ROTATE_KEEP && existsSync(older)) {
        unlinkSync(older);
      }
      const newer = i === 1 ? filePath : `${filePath}.${i - 1}`;
      if (existsSync(newer)) {
        renameSync(newer, older);
      }
    }
  } catch {
    // Best effort — don't block startup if rotation fails
  }
}

export function rotateLogs(): void {
  rotateFile(getLogPath());
  rotateFile(getErrorLogPath());
}

// ── Persisted config (read/write) ──────────────────────────────────

export function parsePersistedConfig(content: string): PersistedConfig | null {
  try {
    const raw = JSON.parse(content);

    if (
      typeof raw.version !== "number" ||
      typeof raw.arkitekApiKey !== "string" ||
      typeof raw.installedAt !== "string" ||
      typeof raw.lastUpdated !== "string"
    ) {
      return null;
    }

    if (
      (raw.arkitekRelayUrl !== undefined && typeof raw.arkitekRelayUrl !== "string") ||
      (raw.gatewayUrl !== undefined && typeof raw.gatewayUrl !== "string") ||
      (raw.agentId !== undefined && typeof raw.agentId !== "string")
    ) {
      return null;
    }

    return raw as PersistedConfig;
  } catch {
    return null;
  }
}

export function readPersistedConfig(): PersistedConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, "utf-8");
    return parsePersistedConfig(content);
  } catch {
    return null;
  }
}

export function writePersistedConfig(config: PersistedConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function isFirstRun(): boolean {
  return readPersistedConfig() === null;
}

// ── .env loader (backward compat) ──────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "ARKITEK_API_KEY",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "ARKITEK_RELAY_URL",
]);

function loadEnvFile(): void {
  const cwdEnv = join(process.cwd(), ".env");
  const openclawEnv = join(homedir(), ".openclaw", "workspace", ".env");
  const locations = [
    { path: cwdEnv, fromCwd: true },
    { path: openclawEnv, fromCwd: false },
  ];

  for (const { path: envPath, fromCwd } of locations) {
    if (!existsSync(envPath)) continue;

    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        let key = trimmed.slice(0, eqIdx).trim();
        if (key.startsWith("export ")) {
          key = key.slice(7).trim();
        }
        if (!key) continue;
        let value = trimmed.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          const quote = value[0];
          value = value.slice(1, -1);
          if (quote === '"') {
            value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          }
        } else {
          const commentIdx = value.indexOf(" #");
          if (commentIdx !== -1) {
            value = value.slice(0, commentIdx);
          }
        }
        if (!process.env[key]) {
          process.env[key] = value;
          if (fromCwd && SENSITIVE_KEYS.has(key)) {
            console.warn(
              `${LOG_PREFIX} WARNING: ${key} loaded from .env in current directory (${envPath}). ` +
                "Verify this is expected — a malicious .env could redirect traffic to an attacker-controlled server.",
            );
          }
        }
      }
    } catch {
      // skip unreadable .env files
    }
  }
}

// ── Config resolution ──────────────────────────────────────────────
//
// Precedence (highest wins):
//   1. CLI flags (--api-key, --gateway-url, etc.)
//   2. Environment variables
//   3. Persisted config (~/.arkitek-relay/config.json)
//   4. Auto-detected from OpenClaw (~/.openclaw/openclaw.json)
//   5. Defaults
//
// Gateway token is NEVER persisted — always read live from CLI, env,
// or OpenClaw config so rotations are picked up automatically.

export function resolveConfig(cli: CLIOptions): ResolvedConfig | null {
  loadEnvFile();

  const persisted = readPersistedConfig();
  const openclaw = detectOpenClaw();

  const source: ConfigSource = {
    arkitekApiKey: "prompt",
    gatewayUrl: "default",
  };

  // ── ArkiTek API Key ──
  let arkitekApiKey: string | undefined;

  if (cli.apiKey) {
    arkitekApiKey = cli.apiKey;
    source.arkitekApiKey = "cli";
  } else if (process.env.ARKITEK_API_KEY) {
    arkitekApiKey = process.env.ARKITEK_API_KEY;
    source.arkitekApiKey = "env";
  } else if (persisted?.arkitekApiKey) {
    arkitekApiKey = persisted.arkitekApiKey;
    source.arkitekApiKey = "persisted";
  }

  if (!arkitekApiKey) return null;

  // ── Gateway URL ──
  let gatewayUrl: string;

  if (cli.gatewayUrl) {
    gatewayUrl = cli.gatewayUrl;
    source.gatewayUrl = "cli";
  } else if (process.env.OPENCLAW_GATEWAY_URL) {
    gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    source.gatewayUrl = "env";
  } else if (persisted?.gatewayUrl) {
    gatewayUrl = persisted.gatewayUrl;
    source.gatewayUrl = "persisted";
  } else if (openclaw) {
    gatewayUrl = openclaw.gatewayUrl;
    source.gatewayUrl = "openclaw";
  } else {
    gatewayUrl = DEFAULT_GATEWAY_URL;
    source.gatewayUrl = "default";
  }

  // ── Gateway Token (never persisted) ──
  let gatewayToken: string | undefined;

  if (cli.gatewayToken) {
    gatewayToken = cli.gatewayToken;
    source.gatewayToken = "cli";
  } else if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    source.gatewayToken = "env";
  } else if (openclaw?.gatewayToken) {
    gatewayToken = openclaw.gatewayToken;
    source.gatewayToken = "openclaw";
  }

  // ── Other options ──
  const arkitekRelayUrl =
    process.env.ARKITEK_RELAY_URL ||
    persisted?.arkitekRelayUrl ||
    DEFAULT_BASE_URL;
  const autoReconnect = process.env.ARKITEK_AUTO_RECONNECT !== "false";
  const agentId =
    cli.agentId ||
    process.env.OPENCLAW_AGENT_ID ||
    persisted?.agentId ||
    "main";

  return {
    arkitekApiKey,
    arkitekRelayUrl,
    autoReconnect,
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    gatewayToken,
    agentId,
    source,
  };
}
