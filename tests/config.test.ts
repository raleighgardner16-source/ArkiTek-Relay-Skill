import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePersistedConfig } from "../src/config/resolver.js";

const TEST_DIR = join(tmpdir(), `arkitek-config-test-${process.pid}`);

function ensureTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
}

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe("parsePersistedConfig validation", () => {
  it("rejects missing required fields", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
    }))).toBeNull();
  });

  it("rejects non-string installedAt", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: 12345,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))).toBeNull();
  });

  it("rejects non-string optional gatewayUrl", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
      gatewayUrl: 12345,
    }))).toBeNull();
  });

  it("rejects non-string optional agentId", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
      agentId: true,
    }))).toBeNull();
  });

  it("rejects non-string optional arkitekRelayUrl", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
      arkitekRelayUrl: [],
    }))).toBeNull();
  });

  it("accepts valid config with required fields only", () => {
    const config = parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
    }));
    expect(config).not.toBeNull();
    expect(config!.arkitekApiKey).toBe("ak_test");
  });

  it("accepts valid config with all optional fields", () => {
    const config = parsePersistedConfig(JSON.stringify({
      version: 1,
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
      gatewayUrl: "http://localhost:18789",
      agentId: "main",
      arkitekRelayUrl: "https://api.arkitekai.com/api/v1/agents/relay",
    }));
    expect(config).not.toBeNull();
    expect(config!.gatewayUrl).toBe("http://localhost:18789");
  });

  it("rejects malformed JSON", () => {
    expect(parsePersistedConfig("{not json")).toBeNull();
  });

  it("rejects non-numeric version", () => {
    expect(parsePersistedConfig(JSON.stringify({
      version: "1",
      arkitekApiKey: "ak_test",
      installedAt: "2025-01-01T00:00:00Z",
      lastUpdated: "2025-01-01T00:00:00Z",
    }))).toBeNull();
  });
});

describe(".env export prefix handling", () => {
  const envKeys = [
    "ARKITEK_API_KEY",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "ARKITEK_RELAY_URL",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    ensureTestDir();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    cleanTestDir();
  });

  it("parses export-prefixed env vars", async () => {
    const envPath = join(TEST_DIR, ".env");
    writeFileSync(envPath, 'export ARKITEK_API_KEY="ak_exporttest"\n');

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const { resolveConfig } = await import("../src/config/resolver.js");
      resolveConfig({ command: "start" });
      expect(process.env.ARKITEK_API_KEY).toBe("ak_exporttest");
    } finally {
      process.cwd = originalCwd;
      delete process.env.ARKITEK_API_KEY;
    }
  });
});
