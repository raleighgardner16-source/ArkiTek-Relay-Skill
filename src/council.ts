import {
  type ArkitekConfig,
  type CouncilRequest,
  type CouncilResponse,
  DEFAULT_BASE_URL,
  LOG_PREFIX,
  MAX_COUNCIL_MODELS,
  MAX_COUNCIL_PROMPT_SIZE,
  COUNCIL_TIMEOUT_MS,
} from "./types.js";
import { validateApiKey, checkTlsSafety, warnIfNotHttps } from "./validation.js";

export async function queryCouncil(
  config: ArkitekConfig,
  prompt: string,
  models?: string[]
): Promise<CouncilResponse> {
  validateApiKey(config.apiKey);
  checkTlsSafety();

  const rawBaseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http:// and https:// protocols are supported");
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid baseUrl "${rawBaseUrl}": not a valid URL`);
    }
    throw err;
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  warnIfNotHttps(baseUrl);
  const url = `${baseUrl}/council`;

  const promptBytes = new TextEncoder().encode(prompt).length;
  if (promptBytes > MAX_COUNCIL_PROMPT_SIZE) {
    throw new Error(
      `Council prompt exceeds 100KB limit (${promptBytes} bytes)`
    );
  }

  if (models && models.length > MAX_COUNCIL_MODELS) {
    throw new Error(
      `Council request exceeds ${MAX_COUNCIL_MODELS} model limit (got ${models.length})`
    );
  }

  const body: CouncilRequest = { prompt };
  if (models && models.length > 0) {
    body.models = models;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(COUNCIL_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${LOG_PREFIX} Council request authentication failed (HTTP ${response.status})`
    );
  }

  if (response.status === 429) {
    throw new Error(
      `${LOG_PREFIX} Council rate limit exceeded (10 requests per minute). Try again later.`
    );
  }

  if (response.status === 402) {
    throw new Error(
      `${LOG_PREFIX} Council requires an active ArkiTek subscription.`
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `${LOG_PREFIX} Council request failed: HTTP ${response.status} — ${errorText}`
    );
  }

  const data: unknown = await response.json();

  if (
    typeof data !== "object" || data === null ||
    typeof (data as Record<string, unknown>).success !== "boolean" ||
    !Array.isArray((data as Record<string, unknown>).responses)
  ) {
    throw new Error(
      `${LOG_PREFIX} Council returned an unexpected response shape`
    );
  }

  return data as CouncilResponse;
}
