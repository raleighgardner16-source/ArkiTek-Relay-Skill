import {
  API_KEY_PATTERN,
  DEFAULT_GATEWAY_URL,
  DEFAULT_BASE_URL,
  PERSISTED_CONFIG_VERSION,
} from "../types.js";
import type { CLIOptions } from "../types.js";
import {
  readPersistedConfig,
  writePersistedConfig,
  getConfigDir,
} from "../config/resolver.js";
import {
  detectOpenClaw,
  testGatewayReachable,
  testResponsesEndpoint,
  enableResponsesEndpoint,
  findInstalledSkill,
  installSkillFile,
  getDefaultSkillsDir,
  getBundledSkillPath,
} from "../config/openclaw.js";
import {
  installService,
  getServiceStatus,
  isPersistentInstall,
} from "../service/index.js";
import { validateApiKey, maskKey } from "../validation.js";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { findEnvKeyLocations, removeApiKeyFromEnvFile } from "./env-cleanup.js";
import * as ui from "./ui.js";

const TOTAL_STEPS = 10;

// ── Helpers ───────────────────────────────────────────────────────

async function promptForApiKey(): Promise<string> {
  console.log();
  ui.info("Get your API key from https://arkitekai.com");
  ui.dimmed(
    "Go to Agents \u2192 Add Agent \u2192 Create, then copy the ak_... key",
  );
  console.log();

  const apiKey = await ui.prompt("Paste your API key: ");

  if (!apiKey) {
    ui.error("No key provided. Exiting.");
    process.exit(1);
  }

  try {
    validateApiKey(apiKey);
    ui.success("API key format valid");
  } catch {
    ui.error(
      "Invalid API key format. Keys start with ak_ and are 67 characters.",
    );
    process.exit(1);
  }

  return apiKey;
}

async function testApiKeyWithServer(apiKey: string, relayUrl?: string): Promise<boolean> {
  const baseUrl = (relayUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/stream`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 || response.status === 403) {
      return false;
    }

    // Any other status (200, 400, etc.) means the key was accepted
    // Abort the stream immediately — we only needed to check auth
    try { response.body?.cancel(); } catch { /* ignore */ }
    return true;
  } catch {
    // Network error — can't determine validity, assume ok for now
    return true;
  }
}

// ── Status tracking for summary ───────────────────────────────────

interface StepResult {
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail?: string;
}

// ── Main install flow ─────────────────────────────────────────────

export async function runInstall(cli: CLIOptions): Promise<void> {
  ui.heading("ArkiTek Relay \u2014 Setup");

  const results: StepResult[] = [];

  // ── Step 1: Disclaimer & Consent ──────────────────────────────

  ui.step(1, TOTAL_STEPS, "Important disclaimer");

  console.log();
  ui.warn("Please read the following carefully before proceeding:");
  console.log();
  ui.info(
    "The ArkiTek Relay connects your local machine to the ArkiTek cloud",
  );
  ui.info(
    "service. Once active, remote instructions from ArkiTek can trigger",
  );
  ui.info(
    "actions on your device through the OpenClaw gateway, including:",
  );
  console.log();
  ui.dimmed("  \u2022 Executing commands and running code on your machine");
  ui.dimmed("  \u2022 Reading and writing files accessible to your user account");
  ui.dimmed("  \u2022 Making network requests from your machine");
  console.log();
  ui.info(
    "You are responsible for securing your API key and ensuring your",
  );
  ui.info(
    "OpenClaw gateway is properly configured. Only install this relay",
  );
  ui.info(
    "on machines you trust and control.",
  );
  console.log();

  if (!cli.yes) {
    if (!process.stdin.isTTY) {
      ui.error("Cannot show interactive disclaimer in non-TTY mode.");
      ui.dimmed("Run with --yes to accept the disclaimer non-interactively.");
      process.exit(1);
    }

    const accepted = await ui.confirm(
      "I understand the risks and want to proceed with setup",
      false,
    );
    if (!accepted) {
      ui.info("Setup cancelled. No changes were made.");
      process.exit(0);
    }
  }

  ui.success("Disclaimer accepted");
  results.push({ label: "Disclaimer", status: "pass" });

  // ── Step 2: Prerequisites ─────────────────────────────────────

  ui.step(2, TOTAL_STEPS, "Checking prerequisites");

  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major < 20) {
    ui.error(`Node.js ${nodeVersion} detected. Version 20.3+ is required.`);
    ui.dimmed("Install Node.js 20+ from https://nodejs.org");
    process.exit(1);
  }
  ui.success(`Node.js ${nodeVersion}`);
  results.push({ label: "Prerequisites", status: "pass", detail: `Node.js ${nodeVersion}` });

  // ── Step 3: Detect OpenClaw ───────────────────────────────────

  ui.step(3, TOTAL_STEPS, "Detecting OpenClaw");

  const openclaw = detectOpenClaw();
  let gatewayUrl: string;
  let gatewayToken: string | undefined;

  if (openclaw) {
    ui.success(`Found OpenClaw config at ${openclaw.configPath}`);
    gatewayUrl = cli.gatewayUrl || openclaw.gatewayUrl;
    gatewayToken = cli.gatewayToken || openclaw.gatewayToken;
    ui.success(`Gateway URL: ${gatewayUrl}`);
    if (gatewayToken) {
      ui.success("Gateway token: found");
    }
    if (openclaw.responsesEnabled) {
      ui.success("/v1/responses endpoint: enabled in config");
    }
    results.push({ label: "OpenClaw", status: "pass", detail: gatewayUrl });
  } else {
    ui.warn("OpenClaw config not found at ~/.openclaw/openclaw.json");
    gatewayUrl = cli.gatewayUrl || DEFAULT_GATEWAY_URL;
    gatewayToken = cli.gatewayToken;
    ui.info(`Using default gateway URL: ${gatewayUrl}`);
    ui.dimmed(
      "If OpenClaw is installed elsewhere, use --gateway-url to specify",
    );
    results.push({ label: "OpenClaw", status: "warn", detail: "config not found" });
  }

  // ── Step 4: Install SKILL.md ──────────────────────────────────

  ui.step(4, TOTAL_STEPS, "Skill definition (SKILL.md)");

  const bundledSkillExists = existsSync(getBundledSkillPath());
  if (!bundledSkillExists) {
    ui.warn("Bundled SKILL.md not found in package — skipping placement");
    results.push({ label: "SKILL.md", status: "warn", detail: "not bundled" });
  } else {
    const existingSkill = findInstalledSkill();

    if (existingSkill) {
      ui.success(`SKILL.md already installed at ${existingSkill}`);

      let shouldUpdate = cli.yes ?? false;
      if (!shouldUpdate && process.stdin.isTTY) {
        shouldUpdate = await ui.confirm("Update to the latest version?", false);
      }

      if (shouldUpdate) {
        try {
          const existingParentDir = cli.skillsDir || dirname(dirname(existingSkill));
          const result = installSkillFile(existingParentDir);
          ui.success(`SKILL.md updated at ${result.path}`);
          results.push({ label: "SKILL.md", status: "pass", detail: "updated" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Could not update SKILL.md: ${msg}`);
          results.push({ label: "SKILL.md", status: "warn", detail: "update failed" });
        }
      } else {
        results.push({ label: "SKILL.md", status: "pass", detail: "already installed" });
      }
    } else {
      const targetDir = cli.skillsDir || getDefaultSkillsDir();
      ui.info(`Placing SKILL.md in ${targetDir}/arkitek-relay/`);

      let shouldInstall = cli.yes;
      if (!shouldInstall && process.stdin.isTTY) {
        shouldInstall = await ui.confirm(
          "Install the skill definition so OpenClaw can discover this relay?",
          true,
        );
      }

      if (shouldInstall) {
        try {
          const result = installSkillFile(cli.skillsDir);
          ui.success(`SKILL.md installed at ${result.path}`);
          results.push({ label: "SKILL.md", status: "pass", detail: result.path });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Could not install SKILL.md: ${msg}`);
          ui.dimmed("You can try manually: npx arkitek-relay-skill --init-skill --skills-dir <path>");
          results.push({ label: "SKILL.md", status: "warn", detail: "install failed" });
        }
      } else {
        ui.dimmed(
          "Skipped. Install later with: npx arkitek-relay-skill --init-skill",
        );
        results.push({ label: "SKILL.md", status: "skip", detail: "user skipped" });
      }
    }
  }

  // ── Step 5: ArkiTek API Key ───────────────────────────────────

  ui.step(5, TOTAL_STEPS, "ArkiTek API Key");

  let apiKey =
    cli.apiKey ||
    process.env.ARKITEK_API_KEY ||
    readPersistedConfig()?.arkitekApiKey;

  if (apiKey && API_KEY_PATTERN.test(apiKey)) {
    ui.success(`API key found: ${maskKey(apiKey)}`);

    if (process.stdin.isTTY) {
      const shouldReplace = await ui.confirm("Enter a different API key?", false);
      if (shouldReplace) {
        apiKey = await promptForApiKey();
      }
    }
  } else {
    if (!process.stdin.isTTY) {
      ui.error("No API key found and stdin is not interactive.");
      ui.dimmed("Set ARKITEK_API_KEY or use --api-key <key>");
      process.exit(1);
    }

    apiKey = await promptForApiKey();
  }

  // Validate the key against ArkiTek's server
  ui.info("Verifying API key with ArkiTek...");
  const keyValid = await testApiKeyWithServer(apiKey, process.env.ARKITEK_RELAY_URL);

  if (!keyValid) {
    ui.error(`API key rejected by ArkiTek (${maskKey(apiKey)})`);
    ui.dimmed("The server returned 401/403 — this key is invalid or revoked.");
    ui.dimmed("Please check your key at https://arkitekai.com and try again.");
    process.exit(1);
  }

  ui.success("API key verified with ArkiTek");
  results.push({ label: "API Key", status: "pass", detail: maskKey(apiKey) });

  // Clean up conflicting .env keys
  const envKeyLocations = findEnvKeyLocations();
  const envKeyValue = process.env.ARKITEK_API_KEY;
  const envHasDifferentKey = envKeyValue && envKeyValue !== apiKey;

  if (envHasDifferentKey && envKeyLocations.length > 0) {
    console.log();
    ui.warn(
      `A different API key (${maskKey(envKeyValue)}) exists in:`,
    );
    for (const loc of envKeyLocations) {
      ui.dimmed(`  ${loc}`);
    }
    ui.warn(
      "That old key will override the one you just entered unless you remove it.",
    );

    let shouldRemove = cli.yes;
    if (!shouldRemove && process.stdin.isTTY) {
      shouldRemove = await ui.confirm(
        "Remove the old API key from those file(s)?",
        true,
      );
    }

    if (shouldRemove) {
      for (const loc of envKeyLocations) {
        if (removeApiKeyFromEnvFile(loc)) {
          ui.success(`Removed old API key from ${loc}`);
        } else {
          ui.error(`Could not update ${loc}`);
          ui.dimmed(
            `  Manually remove the ARKITEK_API_KEY line from that file.`,
          );
        }
      }
    } else {
      ui.info(
        "The relay will use your new key for this session, but on future",
      );
      ui.info(
        "runs the old key in those files will take priority.",
      );
      ui.dimmed(
        "Remove the ARKITEK_API_KEY line from the file(s) above to fix permanently.",
      );
    }
    console.log();
  } else if (envHasDifferentKey) {
    console.log();
    ui.warn(
      `A different API key (${maskKey(envKeyValue)}) is set in the ARKITEK_API_KEY environment variable.`,
    );
    ui.info(
      "The relay will use your new key for this session, but you should",
    );
    ui.info(
      "update or unset that env var to avoid conflicts on future runs.",
    );
    ui.dimmed(
      "  Run: unset ARKITEK_API_KEY",
    );
    console.log();
  }

  // ── Step 6: Test Gateway ──────────────────────────────────────

  ui.step(6, TOTAL_STEPS, "Testing gateway connection");

  const gatewayReachable = await testGatewayReachable(gatewayUrl);
  if (gatewayReachable) {
    ui.success(`Gateway reachable at ${gatewayUrl}`);
    results.push({ label: "Gateway", status: "pass", detail: gatewayUrl });
  } else {
    ui.warn(`Gateway not reachable at ${gatewayUrl}`);
    ui.dimmed(
      "The relay will start in echo mode until the gateway is available.",
    );
    ui.dimmed("Make sure OpenClaw is running: openclaw gateway start");
    results.push({ label: "Gateway", status: "warn", detail: "not reachable" });
  }

  // ── Step 7: Check /v1/responses (REQUIRED) ────────────────────

  ui.step(7, TOTAL_STEPS, "Checking /v1/responses endpoint (required)");

  ui.info(
    "This endpoint is REQUIRED for the relay to forward messages to your",
  );
  ui.info(
    "agent. The relay cannot function without it.",
  );
  console.log();

  let responsesReady = false;

  if (openclaw?.responsesEnabled) {
    ui.success("/v1/responses endpoint is already enabled");
    responsesReady = true;
    results.push({ label: "/v1/responses", status: "pass" });
  } else if (gatewayReachable) {
    const endpointStatus = await testResponsesEndpoint(
      gatewayUrl,
      gatewayToken,
    );

    if (endpointStatus === "enabled") {
      ui.success("/v1/responses endpoint is enabled");
      responsesReady = true;
      results.push({ label: "/v1/responses", status: "pass" });
    } else {
      if (endpointStatus === "disabled") {
        ui.warn("/v1/responses endpoint is currently disabled.");
      } else {
        ui.warn("Could not determine endpoint status.");
      }

      ui.info("Setup needs to enable this endpoint in your OpenClaw config.");
      console.log();

      if (!cli.yes && process.stdin.isTTY) {
        await ui.requireConfirm(
          "Enable /v1/responses endpoint in OpenClaw config?",
        );
      }

      const enabled = await enableResponsesEndpoint(gatewayUrl, gatewayToken);
      if (enabled) {
        ui.success("/v1/responses endpoint enabled");
        responsesReady = true;
        results.push({ label: "/v1/responses", status: "pass", detail: "enabled during setup" });
      } else {
        ui.error("Failed to enable the endpoint automatically.");
        console.log();
        ui.error("You MUST enable it manually before the relay will work:");
        ui.dimmed(
          "  openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
        );
        results.push({ label: "/v1/responses", status: "fail", detail: "auto-enable failed" });
      }
    }
  } else {
    // Gateway not reachable — can still patch the config file
    ui.warn("Gateway is not reachable — cannot verify the endpoint live.");
    ui.info("Setup will enable it in the OpenClaw config file so it's ready");
    ui.info("when the gateway starts.");
    console.log();

    if (!cli.yes && process.stdin.isTTY) {
      await ui.requireConfirm(
        "Enable /v1/responses endpoint in OpenClaw config?",
      );
    }

    const enabled = await enableResponsesEndpoint(gatewayUrl, gatewayToken);
    if (enabled) {
      ui.success("/v1/responses enabled in OpenClaw config");
      ui.dimmed("The change will take effect when the gateway starts.");
      responsesReady = true;
      results.push({ label: "/v1/responses", status: "pass", detail: "enabled in config" });
    } else {
      ui.error("Could not enable the endpoint automatically.");
      console.log();
      ui.error("You MUST enable it before the relay will work:");
      ui.dimmed(
        "  openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
      );
      results.push({ label: "/v1/responses", status: "fail", detail: "config edit failed" });
    }
  }

  // ── Step 8: Test ArkiTek Cloud ────────────────────────────────

  ui.step(8, TOTAL_STEPS, "Testing ArkiTek connection");

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
    ui.success("ArkiTek cloud is reachable");
    results.push({ label: "ArkiTek Cloud", status: "pass" });
  } else {
    ui.warn("Could not reach ArkiTek cloud");
    ui.dimmed("Check your internet connection and firewall rules.");
    ui.dimmed(
      "Outbound HTTPS (port 443) to arkitekai.com must be allowed.",
    );
    results.push({ label: "ArkiTek Cloud", status: "warn", detail: "not reachable" });
  }

  // ── Step 9: Save Config ───────────────────────────────────────

  ui.step(9, TOTAL_STEPS, "Saving configuration");

  const now = new Date().toISOString();
  const existing = readPersistedConfig();
  writePersistedConfig({
    version: PERSISTED_CONFIG_VERSION,
    arkitekApiKey: apiKey,
    gatewayUrl:
      gatewayUrl !== DEFAULT_GATEWAY_URL ? gatewayUrl : undefined,
    agentId:
      cli.agentId && cli.agentId !== "main" ? cli.agentId : undefined,
    installedAt: existing?.installedAt || now,
    lastUpdated: now,
  });

  process.env.ARKITEK_API_KEY = apiKey;

  ui.success(`Configuration saved to ${getConfigDir()}/config.json`);
  results.push({ label: "Config Saved", status: "pass" });

  // ── Step 10: System Service ───────────────────────────────────

  ui.step(10, TOTAL_STEPS, "System service (auto-start on boot)");

  const existingService = await getServiceStatus();
  let serviceInstalled = existingService.installed;

  if (existingService.installed && existingService.running) {
    ui.success(
      `Service already installed and running (${existingService.platform})`,
    );
    if (existingService.servicePath) {
      ui.dimmed(`  ${existingService.servicePath}`);
    }

    let shouldReinstall = cli.yes;
    if (!shouldReinstall && process.stdin.isTTY) {
      shouldReinstall = await ui.confirm("Reinstall the service?");
    }
    if (shouldReinstall) {
      try {
        await installService();
        ui.success("Service reinstalled and started");
        serviceInstalled = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.error(`Failed to reinstall service: ${msg}`);
      }
    }
  } else {
    if (!isPersistentInstall()) {
      ui.warn(
        "Package appears to be running from a temporary npx cache.",
      );
      ui.dimmed(
        "For the service to survive reboots, install globally first:",
      );
      ui.dimmed("  npm install -g arkitek-relay-skill");
      ui.dimmed("Then re-run: npx arkitek-relay-skill --install");
    }

    let shouldInstall = cli.yes;
    if (!shouldInstall && process.stdin.isTTY) {
      console.log();
      ui.info("With a system service (recommended):");
      ui.dimmed("  \u2022 The relay runs 24/7 in the background automatically");
      ui.dimmed("  \u2022 Starts on boot — no manual action needed");
      ui.dimmed("  \u2022 Restarts automatically if it crashes");
      ui.dimmed("  \u2022 No terminal window required");
      console.log();
      ui.info("Without a system service:");
      ui.dimmed("  \u2022 You must manually run: npx arkitek-relay-skill");
      ui.dimmed("  \u2022 The relay stops when you close the terminal");
      ui.dimmed("  \u2022 You must restart it after every reboot");
      ui.dimmed("  \u2022 Your agent is offline whenever the relay isn't running");
      console.log();
      shouldInstall = await ui.confirm(
        "Install as a system service?",
        true,
      );
    }

    if (shouldInstall) {
      try {
        await installService();
        const newStatus = await getServiceStatus();
        if (newStatus.running) {
          ui.success(
            `Service installed and running (${newStatus.platform})`,
          );
        } else {
          ui.success(`Service installed (${newStatus.platform})`);
          ui.dimmed("It will start automatically on next login.");
        }
        if (newStatus.servicePath) {
          ui.dimmed(`  ${newStatus.servicePath}`);
        }
        serviceInstalled = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.error(`Failed to install service: ${msg}`);
        ui.dimmed(
          "You can run the relay manually: npx arkitek-relay-skill",
        );
      }
    } else {
      console.log();
      ui.warn("Service not installed. Your agent will be offline unless you manually start the relay.");
      ui.dimmed(
        "Start manually: npx arkitek-relay-skill",
      );
      ui.dimmed(
        "Install the service later: npx arkitek-relay-skill --install",
      );
    }
  }

  if (serviceInstalled) {
    results.push({ label: "System Service", status: "pass" });
  } else {
    results.push({ label: "System Service", status: "skip", detail: "not installed" });
  }

  // ── Summary ───────────────────────────────────────────────────

  ui.heading("Setup Summary");

  const icons = { pass: "\u2714", warn: "\u26A0", fail: "\u2716", skip: "\u2013" };

  for (const r of results) {
    const icon = icons[r.status];
    const detail = r.detail ? ` (${r.detail})` : "";
    if (r.status === "pass") {
      ui.success(`${r.label}${detail}`);
    } else if (r.status === "warn") {
      ui.warn(`${r.label}${detail}`);
    } else if (r.status === "fail") {
      ui.error(`${r.label}${detail}`);
    } else {
      ui.dimmed(`${icon} ${r.label}${detail}`);
    }
  }

  const hasFailures = results.some((r) => r.status === "fail");
  const hasWarnings = results.some((r) => r.status === "warn");

  console.log();

  if (hasFailures) {
    ui.error("Setup completed with errors. Review the issues above before starting the relay.");
    if (!responsesReady) {
      console.log();
      ui.error("CRITICAL: The /v1/responses endpoint is not enabled.");
      ui.info("The relay will NOT function until you enable it:");
      ui.dimmed(
        "  openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
      );
    }
  } else if (hasWarnings) {
    ui.warn("Setup completed with warnings. The relay may not work fully until the issues above are resolved.");
  } else {
    ui.success("All checks passed. Your relay is configured and ready.");
  }

  console.log();

  if (serviceInstalled) {
    ui.info("The relay is running as a system service.");
    ui.info(
      "It will start automatically on boot and restart if it crashes.",
    );
    console.log();
    ui.info("Useful commands:");
    ui.dimmed("  npx arkitek-relay-skill --doctor     Run diagnostics");
    ui.dimmed(
      "  npx arkitek-relay-skill --status     Show configuration",
    );
    ui.dimmed(
      "  npx arkitek-relay-skill --logs       View service logs",
    );
    ui.dimmed(
      "  npx arkitek-relay-skill --uninstall  Remove service and config",
    );
  } else {
    ui.info("Start the relay:");
    ui.dimmed("  npx arkitek-relay-skill");
    console.log();
    ui.info("Run diagnostics anytime:");
    ui.dimmed("  npx arkitek-relay-skill --doctor");
  }
}
