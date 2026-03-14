import {
  API_KEY_PATTERN,
  DEFAULT_GATEWAY_URL,
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

const TOTAL_STEPS = 9;

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

export async function runInstall(cli: CLIOptions): Promise<void> {
  ui.heading("ArkiTek Relay \u2014 Setup");

  // ── Step 1: Prerequisites ────────────────────────────────────────

  ui.step(1, TOTAL_STEPS, "Checking prerequisites");

  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major < 20) {
    ui.error(`Node.js ${nodeVersion} detected. Version 20.3+ is required.`);
    ui.dimmed("Install Node.js 20+ from https://nodejs.org");
    process.exit(1);
  }
  ui.success(`Node.js ${nodeVersion}`);

  // ── Step 2: Detect OpenClaw ──────────────────────────────────────

  ui.step(2, TOTAL_STEPS, "Detecting OpenClaw");

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
  } else {
    ui.warn("OpenClaw config not found at ~/.openclaw/openclaw.json");
    gatewayUrl = cli.gatewayUrl || DEFAULT_GATEWAY_URL;
    gatewayToken = cli.gatewayToken;
    ui.info(`Using default gateway URL: ${gatewayUrl}`);
    ui.dimmed(
      "If OpenClaw is installed elsewhere, use --gateway-url to specify",
    );
  }

  // ── Step 3: Install SKILL.md ──────────────────────────────────────

  ui.step(3, TOTAL_STEPS, "Skill definition (SKILL.md)");

  const bundledSkillExists = existsSync(getBundledSkillPath());
  if (!bundledSkillExists) {
    ui.warn("Bundled SKILL.md not found in package — skipping placement");
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Could not update SKILL.md: ${msg}`);
        }
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Could not install SKILL.md: ${msg}`);
          ui.dimmed("You can try manually: npx arkitek-relay-skill --init-skill --skills-dir <path>");
        }
      } else {
        ui.dimmed(
          "Skipped. Install later with: npx arkitek-relay-skill --init-skill",
        );
      }
    }
  }

  // ── Step 4: ArkiTek API Key ──────────────────────────────────────

  ui.step(4, TOTAL_STEPS, "ArkiTek API Key");

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

  // ── Step 5: Test Gateway ─────────────────────────────────────────

  ui.step(5, TOTAL_STEPS, "Testing gateway connection");

  const gatewayReachable = await testGatewayReachable(gatewayUrl);
  if (gatewayReachable) {
    ui.success(`Gateway reachable at ${gatewayUrl}`);
  } else {
    ui.warn(`Gateway not reachable at ${gatewayUrl}`);
    ui.dimmed(
      "The relay will start in echo mode until the gateway is available.",
    );
    ui.dimmed("Make sure OpenClaw is running: openclaw gateway start");
  }

  // ── Step 6: Check /v1/responses ──────────────────────────────────

  ui.step(6, TOTAL_STEPS, "Checking /v1/responses endpoint");

  if (!gatewayReachable) {
    ui.dimmed("Skipped (gateway not reachable)");
  } else if (openclaw?.responsesEnabled) {
    ui.success("/v1/responses endpoint is enabled (confirmed from config)");
  } else {
    const endpointStatus = await testResponsesEndpoint(
      gatewayUrl,
      gatewayToken,
    );

    if (endpointStatus === "enabled") {
      ui.success("/v1/responses endpoint is enabled");
    } else if (endpointStatus === "disabled") {
      ui.warn("/v1/responses endpoint is disabled");
      console.log();
      ui.info(
        "The relay needs this endpoint to forward messages to your agent.",
      );

      let shouldEnable = cli.yes;
      if (!shouldEnable && process.stdin.isTTY) {
        shouldEnable = await ui.confirm("Enable it now?");
      }

      if (shouldEnable) {
        const enabled = await enableResponsesEndpoint(
          gatewayUrl,
          gatewayToken,
        );
        if (enabled) {
          ui.success("/v1/responses endpoint enabled");
        } else {
          ui.error("Failed to enable endpoint automatically.");
          ui.dimmed("Enable it manually:");
          ui.dimmed(
            "  openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
          );
        }
      } else {
        ui.warn(
          "Endpoint not enabled. The relay will not be able to forward messages.",
        );
        ui.dimmed("Enable manually later:");
        ui.dimmed(
          "  openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true",
        );
      }
    } else {
      ui.dimmed("Could not determine endpoint status");
    }
  }

  // ── Step 7: Test ArkiTek Cloud ───────────────────────────────────

  ui.step(7, TOTAL_STEPS, "Testing ArkiTek connection");

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
  } else {
    ui.warn("Could not reach ArkiTek cloud");
    ui.dimmed("Check your internet connection and firewall rules.");
    ui.dimmed(
      "Outbound HTTPS (port 443) to arkitekai.com must be allowed.",
    );
  }

  // ── Step 8: Save Config ──────────────────────────────────────────

  ui.step(8, TOTAL_STEPS, "Saving configuration");

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

  // ── Step 9: System Service ───────────────────────────────────────

  ui.step(9, TOTAL_STEPS, "System service (auto-start on boot)");

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
      ui.info(
        "A system service starts the relay automatically on boot",
      );
      ui.info(
        "and keeps it running in the background. No terminal needed.",
      );
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
      ui.dimmed(
        "Skipped. You can install it later with: npx arkitek-relay-skill --install",
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────

  ui.heading("Setup Complete");
  ui.success("Your relay is configured and ready.");
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
