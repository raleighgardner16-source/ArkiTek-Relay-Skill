import {
  readFileSync,
  lstatSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { OpenClawDetectedConfig } from "../types.js";
import { LOG_PREFIX } from "../types.js";

const SKILL_NAME = "arkitek-relay";

const MAX_CONFIG_SIZE = 1_000_000;

/**
 * Securely reads ~/.openclaw/openclaw.json and extracts gateway configuration.
 *
 * Security checks (matching kubectl, docker, ssh conventions):
 * - Verifies the file is a regular file (not a symlink)
 * - Verifies ownership matches the current user (Unix only)
 * - Warns if the file has overly permissive permissions
 * - Enforces a size limit to prevent memory exhaustion
 * - Validates the parsed JSON shape before returning
 */
export function detectOpenClaw(): OpenClawDetectedConfig | null {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");

  if (!existsSync(configPath)) {
    return null;
  }

  const stat = lstatSync(configPath);
  if (!stat.isFile()) {
    console.warn(
      `${LOG_PREFIX} ${configPath} is not a regular file, skipping auto-detection`,
    );
    return null;
  }

  const getuid = process.getuid;
  if (typeof getuid === "function") {
    const currentUid = getuid();
    if (stat.uid !== currentUid) {
      console.warn(
        `${LOG_PREFIX} ${configPath} is owned by uid ${stat.uid}, current user is ${currentUid}. Skipping.`,
      );
      return null;
    }
  }

  const mode = stat.mode & 0o777;
  if (mode & 0o004) {
    console.warn(
      `${LOG_PREFIX} Warning: ${configPath} is world-readable. Consider running: chmod 600 ${configPath}`,
    );
  }

  if (stat.size > MAX_CONFIG_SIZE) {
    console.warn(
      `${LOG_PREFIX} ${configPath} is suspiciously large (${stat.size} bytes), skipping`,
    );
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);

    const port =
      typeof raw.gateway?.port === "number" ? raw.gateway.port : 18789;
    const gatewayUrl = `http://localhost:${port}`;
    const gatewayToken =
      typeof raw.gateway?.auth?.token === "string"
        ? raw.gateway.auth.token
        : undefined;
    const responsesEnabled =
      raw.gateway?.http?.endpoints?.responses?.enabled === true;

    return { configPath, gatewayUrl, gatewayToken, responsesEnabled };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} Failed to parse ${configPath}: ${msg}`);
    return null;
  }
}

/**
 * Checks whether the OpenClaw gateway is responding at the given URL.
 * Uses a simple GET request — no side effects.
 */
export async function testGatewayReachable(
  gatewayUrl: string,
): Promise<boolean> {
  try {
    await fetch(gatewayUrl.replace(/\/+$/, ""), {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes the /v1/responses endpoint to determine whether it's active.
 * Sends an empty JSON body which will be rejected by validation without
 * triggering an actual agent invocation.
 *
 * - 405 → endpoint is disabled at the gateway level
 * - Any other status → endpoint is active (even 400/401 means the route exists)
 */
export async function testResponsesEndpoint(
  gatewayUrl: string,
  token?: string,
): Promise<"enabled" | "disabled" | "unknown"> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(
      `${gatewayUrl.replace(/\/+$/, "")}/v1/responses`,
      {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(3_000),
      },
    );

    if (response.status === 405) return "disabled";
    if (response.status >= 500) return "unknown";
    return "enabled";
  } catch {
    return "unknown";
  }
}

/**
 * Patches the OpenClaw gateway config to enable the /v1/responses endpoint.
 */
export async function enableResponsesEndpoint(
  gatewayUrl: string,
  token?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(
      `${gatewayUrl.replace(/\/+$/, "")}/api/gateway/config/patch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          gateway: {
            http: {
              endpoints: {
                responses: { enabled: true },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}

// ── SKILL.md placement ─────────────────────────────────────────────

/**
 * Resolves the path to the bundled SKILL.md shipped inside this package.
 * Works from the compiled dist/config/openclaw.js (two levels up to package root).
 */
export function getBundledSkillPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..", "..", "SKILL.md");
}

/**
 * Returns the default OpenClaw skills directory (~/.openclaw/skills).
 */
export function getDefaultSkillsDir(): string {
  return join(homedir(), ".openclaw", "skills");
}

/**
 * Reads openclaw.json and returns any extra skill directories the user has
 * configured via skills.load.extraDirs. Falls back to an empty array.
 */
export function getExtraSkillsDirs(): string[] {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const extraDirs = raw.skills?.load?.extraDirs;
    if (!Array.isArray(extraDirs)) return [];
    return extraDirs
      .filter((d: unknown): d is string => typeof d === "string")
      .map((d) => d.replace(/^~/, homedir()));
  } catch {
    return [];
  }
}

/**
 * All directories where OpenClaw might look for skills (default + extras).
 */
export function getAllSkillsDirs(): string[] {
  return [getDefaultSkillsDir(), ...getExtraSkillsDirs()];
}

export interface SkillInstallResult {
  installed: boolean;
  path: string;
  existed: boolean;
}

/**
 * Copies the bundled SKILL.md into the target skills directory.
 *
 * Target layout: <skillsDir>/arkitek-relay/SKILL.md
 *
 * If targetDir is not provided, uses ~/.openclaw/skills.
 */
export function installSkillFile(targetDir?: string): SkillInstallResult {
  const bundledPath = getBundledSkillPath();
  if (!existsSync(bundledPath)) {
    throw new Error(
      `Bundled SKILL.md not found at ${bundledPath}. The package may be corrupted.`,
    );
  }

  const skillDir = join(
    targetDir || getDefaultSkillsDir(),
    SKILL_NAME,
  );
  const targetPath = join(skillDir, "SKILL.md");
  const existed = existsSync(targetPath);

  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }

  copyFileSync(bundledPath, targetPath);

  return { installed: true, path: targetPath, existed };
}

/**
 * Searches all known skill directories for an existing arkitek-relay SKILL.md.
 * Returns the path if found, null otherwise.
 */
export function findInstalledSkill(): string | null {
  for (const dir of getAllSkillsDirs()) {
    const skillPath = join(dir, SKILL_NAME, "SKILL.md");
    if (existsSync(skillPath)) return skillPath;
  }
  return null;
}
