import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { ServiceConfig, ServiceInfo } from "../types.js";
import { SERVICE_LABEL } from "../types.js";

const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_LABEL}.plist`);

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPlist(config: ServiceConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(config.nodePath)}</string>
        <string>${escapeXml(config.scriptPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(config.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(config.errorLogPath)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(homedir())}</string>
</dict>
</plist>
`;
}

export function install(config: ServiceConfig): void {
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  // Unload existing service if present (ignore errors if not loaded)
  if (existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // not currently loaded, that's fine
    }
  }

  writeFileSync(PLIST_PATH, buildPlist(config), { mode: 0o644 });
  execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
}

export function uninstall(): void {
  if (!existsSync(PLIST_PATH)) {
    return;
  }

  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    // not loaded
  }

  unlinkSync(PLIST_PATH);
}

export function status(): ServiceInfo {
  const installed = existsSync(PLIST_PATH);

  let running = false;
  if (installed) {
    try {
      const output = execSync(`launchctl list "${SERVICE_LABEL}"`, {
        stdio: "pipe",
        encoding: "utf-8",
      });
      running = /["']?PID["']?\s*[=:]\s*\d+/.test(output) ||
        output.includes('"PID"');
    } catch {
      // not loaded
    }
  }

  return {
    installed,
    running,
    platform: "darwin",
    servicePath: PLIST_PATH,
  };
}
