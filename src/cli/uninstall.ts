import { existsSync, rmSync } from "node:fs";
import type { CLIOptions } from "../types.js";
import { getConfigDir } from "../config/resolver.js";
import {
  getServiceStatus,
  uninstallService,
} from "../service/index.js";
import { findEnvKeyLocations, removeApiKeyFromEnvFile } from "./env-cleanup.js";
import * as ui from "./ui.js";

export async function runUninstall(cli: CLIOptions): Promise<void> {
  ui.heading("ArkiTek Relay \u2014 Uninstall");

  const configDir = getConfigDir();
  const service = await getServiceStatus();
  const envKeyLocations = findEnvKeyLocations();
  const hasAnything = existsSync(configDir) || service.installed || envKeyLocations.length > 0;

  if (!hasAnything) {
    ui.info("Nothing to uninstall. No config, service, or API keys found.");
    return;
  }

  // Show what will be removed
  if (service.installed) {
    ui.info(
      `System service: ${service.servicePath || service.platform} ${service.running ? "(running)" : "(stopped)"}`,
    );
  }
  if (existsSync(configDir)) {
    ui.info(`Config directory: ${configDir}`);
  }
  if (envKeyLocations.length > 0) {
    ui.info("ARKITEK_API_KEY found in .env file(s):");
    for (const loc of envKeyLocations) {
      ui.dimmed(`  ${loc}`);
    }
  }

  let shouldProceed = cli.yes;
  if (!shouldProceed && process.stdin.isTTY) {
    console.log();
    ui.warn("This will remove the system service, all relay configuration, and API keys from .env files.");
    shouldProceed = await ui.confirm("Continue?");
  }

  if (!shouldProceed) {
    ui.info("Cancelled.");
    return;
  }

  // 1. Stop and remove system service
  if (service.installed) {
    try {
      await uninstallService();
      ui.success("System service removed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(`Failed to remove service: ${msg}`);
      if (service.servicePath) {
        ui.dimmed(`You may need to manually delete: ${service.servicePath}`);
      }
    }
  }

  // 2. Remove config directory
  if (existsSync(configDir)) {
    try {
      rmSync(configDir, { recursive: true, force: true });
      ui.success(`Removed ${configDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(`Failed to remove config directory: ${msg}`);
    }
  }

  // 3. Remove ARKITEK_API_KEY from .env files
  for (const loc of envKeyLocations) {
    if (removeApiKeyFromEnvFile(loc)) {
      ui.success(`Removed ARKITEK_API_KEY from ${loc}`);
    } else {
      ui.error(`Could not update ${loc}`);
      ui.dimmed(`  Manually remove the ARKITEK_API_KEY line from that file.`);
    }
  }

  console.log();
  ui.success("Uninstall complete.");
  ui.dimmed(
    "To fully remove the package: npm uninstall -g arkitek-relay-skill",
  );
}
