import type { CLIOptions } from "../types.js";
import { DEFAULT_GATEWAY_URL } from "../types.js";
import {
  readPersistedConfig,
  getConfigPath,
  getLogPath,
  getErrorLogPath,
} from "../config/resolver.js";
import { existsSync, statSync } from "node:fs";
import {
  detectOpenClaw,
  testGatewayReachable,
  testResponsesEndpoint,
  findInstalledSkill,
} from "../config/openclaw.js";
import { getServiceStatus } from "../service/index.js";
import { maskKey } from "../validation.js";
import * as ui from "./ui.js";

export async function runDoctor(cli: CLIOptions): Promise<void> {
  ui.heading("ArkiTek Relay \u2014 Diagnostics");

  let issues = 0;

  // 1. Node.js
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major >= 20) {
    ui.success(`Node.js ${nodeVersion}`);
  } else {
    ui.error(`Node.js ${nodeVersion} \u2014 version 20.3+ required`);
    issues++;
  }

  // 2. Persisted config
  const persisted = readPersistedConfig();
  if (persisted) {
    ui.success(`Config found at ${getConfigPath()}`);
    ui.dimmed(`  Installed: ${persisted.installedAt}`);
    ui.dimmed(`  Updated:   ${persisted.lastUpdated}`);
  } else {
    ui.warn("No saved config found. Run --install to set up.");
    issues++;
  }

  // 3. API key
  const apiKey =
    cli.apiKey || process.env.ARKITEK_API_KEY || persisted?.arkitekApiKey;
  if (apiKey) {
    ui.success(`ArkiTek API key: ${maskKey(apiKey)}`);
  } else {
    ui.error("No ArkiTek API key found");
    ui.dimmed("  Set ARKITEK_API_KEY, use --api-key, or run --install");
    issues++;
  }

  // 4. OpenClaw config
  const openclaw = detectOpenClaw();
  if (openclaw) {
    ui.success(`OpenClaw config: ${openclaw.configPath}`);
    ui.dimmed(`  Gateway URL: ${openclaw.gatewayUrl}`);
    ui.dimmed(
      `  Gateway token: ${openclaw.gatewayToken ? "present" : "not set"}`,
    );
    ui.dimmed(
      `  /v1/responses: ${openclaw.responsesEnabled ? "enabled" : "disabled"}`,
    );

    if (!openclaw.responsesEnabled) {
      ui.warn("/v1/responses endpoint is disabled in OpenClaw config");
      ui.dimmed(
        "  Fix: openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
      );
      issues++;
    }
  } else {
    ui.warn("OpenClaw config not found at ~/.openclaw/openclaw.json");
    issues++;
  }

  // 5. Gateway reachability
  const gatewayUrl =
    cli.gatewayUrl ||
    process.env.OPENCLAW_GATEWAY_URL ||
    openclaw?.gatewayUrl ||
    DEFAULT_GATEWAY_URL;
  const gatewayReachable = await testGatewayReachable(gatewayUrl);
  if (gatewayReachable) {
    ui.success(`Gateway reachable at ${gatewayUrl}`);
  } else {
    ui.error(`Gateway not reachable at ${gatewayUrl}`);
    ui.dimmed("  Is OpenClaw running? Try: openclaw gateway start");
    issues++;
  }

  // 6. /v1/responses live check
  if (gatewayReachable) {
    const gatewayToken =
      cli.gatewayToken ||
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      openclaw?.gatewayToken;
    const endpointStatus = await testResponsesEndpoint(
      gatewayUrl,
      gatewayToken,
    );
    if (endpointStatus === "enabled") {
      ui.success("/v1/responses endpoint is responding");
    } else if (endpointStatus === "disabled") {
      ui.error("/v1/responses endpoint returned 405 (disabled)");
      ui.dimmed(
        "  Fix: openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
      );
      issues++;
    } else {
      ui.warn("/v1/responses endpoint status unknown");
    }
  }

  // 7. ArkiTek cloud
  let arkitekReachable = false;
  try {
    await fetch("https://arkitekai.com", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    arkitekReachable = true;
  } catch {
    // not reachable
  }

  if (arkitekReachable) {
    ui.success("ArkiTek cloud reachable (arkitekai.com)");
  } else {
    ui.error("Cannot reach arkitekai.com");
    ui.dimmed(
      "  Check internet connection and firewall (outbound HTTPS port 443)",
    );
    issues++;
  }

  // 8. System service
  const service = await getServiceStatus();
  if (service.installed) {
    if (service.running) {
      ui.success(`System service: running (${service.platform})`);
    } else {
      ui.warn(`System service: installed but not running (${service.platform})`);
      issues++;
    }
    if (service.servicePath) {
      ui.dimmed(`  ${service.servicePath}`);
    }
  } else {
    ui.dimmed("System service: not installed (optional)");
    ui.dimmed("  Install with: npx arkitek-relay-skill --install");
  }

  // 9. SKILL.md placement
  const skillPath = findInstalledSkill();
  if (skillPath) {
    ui.success(`Skill definition installed: ${skillPath}`);
  } else {
    ui.warn("SKILL.md not found in OpenClaw skills directory");
    ui.dimmed(
      "  Fix: npx arkitek-relay-skill --init-skill",
    );
    issues++;
  }

  // 10. Log file sizes
  const LOG_WARN_BYTES = 100 * 1024 * 1024; // 100MB
  for (const [label, logFile] of [
    ["Output log", getLogPath()],
    ["Error log", getErrorLogPath()],
  ] as const) {
    if (existsSync(logFile)) {
      const size = statSync(logFile).size;
      if (size > LOG_WARN_BYTES) {
        const sizeMB = (size / (1024 * 1024)).toFixed(0);
        ui.warn(`${label} is ${sizeMB}MB — consider truncating`);
        ui.dimmed(`  File: ${logFile}`);
        ui.dimmed(`  Truncate: : > "${logFile}"`);
        issues++;
      }
    }
  }

  // Summary
  console.log();
  if (issues === 0) {
    ui.success("All checks passed. Your relay should work correctly.");
  } else {
    ui.warn(
      `${issues} issue${issues > 1 ? "s" : ""} found. Fix the items above and run --doctor again.`,
    );
  }
}
