import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceConfig, ServiceInfo } from "../types.js";

const TASK_NAME = "ArkiTekRelay";

export function install(config: ServiceConfig): void {
  // Remove existing task if present (ignore errors)
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: "pipe" });
  } catch {
    // didn't exist
  }

  // Use XML import to avoid nested-quoting issues with schtasks /tr
  const xmlContent = buildTaskXml(config);
  const tmpXml = join(tmpdir(), `arkitek-relay-task-${Date.now()}.xml`);
  try {
    writeFileSync(tmpXml, xmlContent, { encoding: "utf-8" });
    execSync(`schtasks /create /tn "${TASK_NAME}" /xml "${tmpXml}" /f`, { stdio: "pipe" });
  } finally {
    try { unlinkSync(tmpXml); } catch { /* best effort cleanup */ }
  }

  try {
    execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: "pipe" });
  } catch {
    // may fail if already running
  }
}

export function uninstall(): void {
  try {
    execSync(`schtasks /end /tn "${TASK_NAME}"`, { stdio: "pipe" });
  } catch {
    // not running
  }

  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: "pipe" });
  } catch {
    // didn't exist
  }
}

export function status(): ServiceInfo {
  let installed = false;
  let running = false;

  try {
    const output = execSync(
      `schtasks /query /tn "${TASK_NAME}" /fo LIST`,
      { stdio: "pipe", encoding: "utf-8" },
    );
    installed = true;
    running = output.includes("Running");
  } catch {
    // task doesn't exist
  }

  return { installed, running, platform: "win32" };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildTaskXml(config: ServiceConfig): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <RestartOnFailure>
      <Interval>PT30S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(config.nodePath)}</Command>
      <Arguments>${escapeXml(config.scriptPath)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}
