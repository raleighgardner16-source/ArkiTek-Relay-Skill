import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceConfig, ServiceInfo } from "../types.js";
import { getLogPath, getErrorLogPath } from "../config/resolver.js";

// ── Path resolution ────────────────────────────────────────────────

export function getServiceConfig(): ServiceConfig {
  const thisFile = fileURLToPath(import.meta.url);
  const scriptPath = resolve(dirname(thisFile), "..", "index.js");

  return {
    nodePath: process.execPath,
    scriptPath,
    logPath: getLogPath(),
    errorLogPath: getErrorLogPath(),
  };
}

/**
 * Returns true if the relay appears to be running from a persistent
 * install (global npm, local node_modules) rather than a temporary
 * npx cache that may be cleaned up.
 */
export function isPersistentInstall(): boolean {
  const config = getServiceConfig();
  const lower = config.scriptPath.toLowerCase();
  const tempIndicators = ["_npx", ".npx", "/tmp/", "/temp/", "appdata/local/temp"];
  return !tempIndicators.some((t) => lower.includes(t));
}

// ── Platform dispatch ──────────────────────────────────────────────

export async function installService(): Promise<void> {
  const config = getServiceConfig();
  const platform = process.platform;

  if (platform === "darwin") {
    const darwin = await import("./darwin.js");
    darwin.install(config);
  } else if (platform === "linux") {
    const linux = await import("./linux.js");
    linux.install(config);
  } else if (platform === "win32") {
    const win32 = await import("./win32.js");
    win32.install(config);
  } else {
    throw new Error(
      `Platform "${platform}" is not supported for system service installation. ` +
        "Run the relay manually instead.",
    );
  }
}

export async function uninstallService(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    const darwin = await import("./darwin.js");
    darwin.uninstall();
  } else if (platform === "linux") {
    const linux = await import("./linux.js");
    linux.uninstall();
  } else if (platform === "win32") {
    const win32 = await import("./win32.js");
    win32.uninstall();
  }
  // Unsupported platforms: nothing to uninstall
}

export async function getServiceStatus(): Promise<ServiceInfo> {
  const platform = process.platform;

  if (platform === "darwin") {
    const darwin = await import("./darwin.js");
    return darwin.status();
  } else if (platform === "linux") {
    const linux = await import("./linux.js");
    return linux.status();
  } else if (platform === "win32") {
    const win32 = await import("./win32.js");
    return win32.status();
  }

  return {
    installed: false,
    running: false,
    platform,
  };
}
