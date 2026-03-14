import {
  readPersistedConfig,
  getConfigPath,
} from "../config/resolver.js";
import { getServiceStatus } from "../service/index.js";
import { maskKey } from "../validation.js";
import * as ui from "./ui.js";

export async function runStatus(): Promise<void> {
  ui.heading("ArkiTek Relay \u2014 Status");

  const config = readPersistedConfig();
  if (!config) {
    ui.warn("Not configured. Run: npx arkitek-relay-skill --install");
    return;
  }

  ui.info(`Config:       ${getConfigPath()}`);
  ui.info(`API key:      ${maskKey(config.arkitekApiKey)}`);
  ui.info(`Installed:    ${config.installedAt}`);
  ui.info(`Last updated: ${config.lastUpdated}`);

  if (config.gatewayUrl) {
    ui.info(`Gateway URL:  ${config.gatewayUrl}`);
  }
  if (config.agentId) {
    ui.info(`Agent ID:     ${config.agentId}`);
  }

  // System service
  console.log();
  const service = await getServiceStatus();
  if (service.installed) {
    if (service.running) {
      ui.success(`System service: running (${service.platform})`);
    } else {
      ui.warn(`System service: installed but not running (${service.platform})`);
    }
    if (service.servicePath) {
      ui.dimmed(`  ${service.servicePath}`);
    }
  } else {
    ui.dimmed("System service: not installed");
    ui.dimmed("  Install with: npx arkitek-relay-skill --install");
  }

  console.log();
  ui.dimmed("For full diagnostics, run: npx arkitek-relay-skill --doctor");
}
