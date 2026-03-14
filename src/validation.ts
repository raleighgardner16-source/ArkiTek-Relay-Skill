import { API_KEY_PATTERN, LOG_PREFIX } from "./types.js";

export function maskKey(key: string): string {
  if (!key || key.length < 8) return "ak_****";
  return `ak_****...${key.slice(-4)}`;
}

export function validateApiKey(key: string): void {
  if (!key) {
    throw new Error("ARKITEK_API_KEY is required");
  }
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid API key format. Expected ak_ prefix followed by 64 alphanumeric characters (67 total). Got ${key.length} characters.`
    );
  }
}

export function checkTlsSafety(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 detected. Refusing to connect — TLS verification must be enabled for secure communication with ArkiTek."
    );
  }
}

const MAX_WARNED_URLS = 50;
const warnedUrls = new Set<string>();

export function warnIfNotHttps(url: string): void {
  if (warnedUrls.has(url)) return;
  if (!url.startsWith("https://") && !url.startsWith("http://localhost") && !url.startsWith("http://127.0.0.1")) {
    console.warn(
      `${LOG_PREFIX} WARNING: baseUrl "${url}" is not using HTTPS. ` +
        "Your API key may be transmitted in plain text. " +
        "Use HTTPS in production to prevent credential exposure."
    );
    if (warnedUrls.size >= MAX_WARNED_URLS) {
      const first = warnedUrls.values().next().value;
      if (first !== undefined) warnedUrls.delete(first);
    }
    warnedUrls.add(url);
  }
}
