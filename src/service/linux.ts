import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { ServiceConfig, ServiceInfo } from "../types.js";

const SERVICE_NAME = "arkitek-relay";
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, `${SERVICE_NAME}.service`);

function buildUnit(config: ServiceConfig): string {
  return `[Unit]
Description=ArkiTek Relay - Connect OpenClaw agent to ArkiTek
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${config.nodePath}" "${config.scriptPath}"
Restart=always
RestartSec=30
StandardOutput=append:"${config.logPath}"
StandardError=append:"${config.errorLogPath}"
WorkingDirectory="${homedir()}"

[Install]
WantedBy=default.target
`;
}

export function install(config: ServiceConfig): void {
  if (!existsSync(UNIT_DIR)) {
    mkdirSync(UNIT_DIR, { recursive: true });
  }

  // Stop existing service if running (ignore errors)
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "pipe" });
  } catch {
    // not running
  }

  writeFileSync(UNIT_PATH, buildUnit(config), { mode: 0o644 });
  execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: "pipe" });
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: "pipe" });
}

export function uninstall(): void {
  if (!existsSync(UNIT_PATH)) {
    return;
  }

  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "pipe" });
  } catch {
    // not running
  }

  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, {
      stdio: "pipe",
    });
  } catch {
    // not enabled
  }

  unlinkSync(UNIT_PATH);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch {
    // best effort
  }
}

export function status(): ServiceInfo {
  const installed = existsSync(UNIT_PATH);

  let running = false;
  if (installed) {
    try {
      const output = execSync(
        `systemctl --user is-active ${SERVICE_NAME}`,
        { stdio: "pipe", encoding: "utf-8" },
      );
      running = output.trim() === "active";
    } catch {
      // inactive or not found
    }
  }

  return {
    installed,
    running,
    platform: "linux",
    servicePath: UNIT_PATH,
  };
}
