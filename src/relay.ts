import {
  type ArkitekConfig,
  type ArkitekRelayEvents,
  type ConnectedEvent,
  type ConnectionState,
  type IncomingMessage,
  type MessageHandler,
  type PingEvent,
  type RespondPayload,
  type RespondResponse,
  DEFAULT_BASE_URL,
  HEARTBEAT_TIMEOUT_MS,
  LOG_PREFIX,
  MAX_RESPONSE_SIZE,
  MAX_RECONNECT_ATTEMPTS,
  MAX_CONCURRENT_HANDLERS,
  RESPOND_TIMEOUT_MS,
  RESPOND_MAX_RETRIES,
  RESPOND_RETRY_DELAY_MS,
  CONNECT_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  MAX_SSE_BUFFER_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_SIZE,
  GRACEFUL_DRAIN_MS,
  GRACEFUL_DRAIN_POLL_MS,
} from "./types.js";
import { maskKey, validateApiKey, checkTlsSafety, warnIfNotHttps } from "./validation.js";

export { maskKey, validateApiKey, checkTlsSafety, warnIfNotHttps };

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args);
}

function backoffDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  const jitter = Math.random() * base * 0.3;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayClient {
  private readonly config: Required<Pick<ArkitekConfig, "apiKey" | "baseUrl">> &
    Pick<ArkitekConfig, "autoReconnect">;
  private readonly handler: MessageHandler;
  private readonly events: ArkitekRelayEvents;

  private state: ConnectionState = "disconnected";
  private abortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private activeHandlers = 0;
  private agentId: string | null = null;
  private shutdownRequested = false;

  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  private readonly boundShutdown: () => void;

  constructor(
    config: ArkitekConfig,
    handler: MessageHandler,
    events: ArkitekRelayEvents = {}
  ) {
    validateApiKey(config.apiKey);
    checkTlsSafety();

    const resolvedUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    try {
      const parsed = new URL(resolvedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// protocols are supported");
      }
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(`Invalid baseUrl "${resolvedUrl}": not a valid URL`);
      }
      throw err;
    }

    this.config = {
      apiKey: config.apiKey,
      baseUrl: resolvedUrl.replace(/\/+$/, ""),
      autoReconnect: config.autoReconnect ?? true,
    };
    warnIfNotHttps(this.config.baseUrl);
    this.handler = handler;
    this.events = events;

    this.boundShutdown = () => {
      this.gracefulDisconnect("process signal").catch(() => {});
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") {
      log("Already connected or connecting");
      return;
    }
    if (this.state === "auth_failed") {
      const err = new Error(
        "Cannot connect — API key was previously rejected. Please check your key and create a new RelayClient instance."
      );
      logError(err.message);
      throw err;
    }

    this.shutdownRequested = false;
    this.registerShutdownHandlers();

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openStream().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.connectReject?.(error);
        this.connectResolve = null;
        this.connectReject = null;
      });
    });
  }

  disconnect(reason = "manual"): void {
    this.forceDisconnect(reason);
  }

  async gracefulDisconnect(reason = "manual"): Promise<void> {
    this.shutdownRequested = true;

    if (this.activeHandlers > 0) {
      log(`Waiting up to ${GRACEFUL_DRAIN_MS / 1000}s for ${this.activeHandlers} in-flight handler(s) to complete...`);
      const deadline = Date.now() + GRACEFUL_DRAIN_MS;
      while (this.activeHandlers > 0 && Date.now() < deadline) {
        await sleep(GRACEFUL_DRAIN_POLL_MS);
      }
      if (this.activeHandlers > 0) {
        log(`Drain timeout reached with ${this.activeHandlers} handler(s) still active. Forcing disconnect.`);
      } else {
        log("All handlers drained successfully.");
      }
    }

    this.forceDisconnect(reason);
  }

  private forceDisconnect(reason: string): void {
    this.shutdownRequested = true;

    // Capture and clear the pending connect callbacks before cleanup,
    // since aborting the controller could trigger async handlers that
    // also reference these callbacks.
    const pendingReject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;

    this.cleanup();
    this.state = "disconnected";
    this.unregisterShutdownHandlers();
    log(`Disconnected (reason: ${reason})`);
    this.emitSafe("onDisconnect", reason);
    if (pendingReject) {
      pendingReject(new Error(`Disconnected before connection was established (reason: ${reason})`));
    }
  }

  private registerShutdownHandlers(): void {
    process.on("SIGINT", this.boundShutdown);
    process.on("SIGTERM", this.boundShutdown);
  }

  private unregisterShutdownHandlers(): void {
    process.removeListener("SIGINT", this.boundShutdown);
    process.removeListener("SIGTERM", this.boundShutdown);
  }

  private cleanup(): void {
    this.abortController?.abort();
    this.abortController = null;

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async openStream(): Promise<void> {
    this.state = "connecting";
    this.abortController = new AbortController();
    const url = `${this.config.baseUrl}/stream`;

    log(`Connecting to ${url}...`);

    try {
      const timeoutSignal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
      const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal,
      });

      if (response.status === 401 || response.status === 403) {
        this.state = "auth_failed";
        const authErr = new Error(
          `API key invalid or revoked (HTTP ${response.status}). Key: ${maskKey(this.config.apiKey)}. ` +
            "Will NOT retry. Please check your API key in ArkiTek."
        );
        logError(authErr.message);
        this.cleanup();
        this.unregisterShutdownHandlers();
        this.emitSafe("onError", authErr);
        this.connectReject?.(authErr);
        this.connectResolve = null;
        this.connectReject = null;
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null — SSE stream not available");
      }

      this.reconnectAttempt = 0;
      this.startHeartbeatMonitor();
      await this.consumeStream(response.body);
    } catch (err: unknown) {
      if (this.shutdownRequested) return;
      if (err instanceof Error && err.name === "AbortError") return;

      const message = err instanceof Error ? err.message : String(err);
      logError(`Connection error: ${message}`);
      const error = err instanceof Error ? err : new Error(message);
      this.emitSafe("onError", error);

      if (this.connectReject) {
        this.connectReject(error);
        this.connectResolve = null;
        this.connectReject = null;
      }

      this.scheduleReconnect();
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        if (buffer.length > MAX_SSE_BUFFER_SIZE) {
          logError("SSE buffer exceeded 1MB limit — disconnecting to prevent memory exhaustion");
          reader.cancel();
          this.scheduleReconnect();
          return;
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            if (currentData) currentData += "\n";
            const raw = line.slice(5);
            currentData += raw.startsWith(" ") ? raw.slice(1) : raw;
          } else if (line === "") {
            if (currentEvent && currentData) {
              this.handleSSEEvent(currentEvent, currentData);
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err: unknown) {
      if (this.shutdownRequested) return;
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    } finally {
      reader.releaseLock();
    }

    if (!this.shutdownRequested) {
      log("SSE stream ended");
      this.scheduleReconnect();
    }
  }

  private handleSSEEvent(event: string, rawData: string): void {
    try {
      switch (event) {
        case "connected": {
          const data = JSON.parse(rawData) as ConnectedEvent;
          if (typeof data.agentId !== "string" || !data.agentId) {
            logError("Received malformed connected event — missing or invalid agentId");
            break;
          }
          this.state = "connected";
          this.agentId = data.agentId;
          log(`Connected — agent ID: ${data.agentId}`);
          this.emitSafe("onConnect", data.agentId);
          this.connectResolve?.();
          this.connectResolve = null;
          this.connectReject = null;
          break;
        }
        case "ping": {
          const data = JSON.parse(rawData) as PingEvent;
          if (typeof data.t !== "number" || !Number.isFinite(data.t)) {
            logError("Received malformed ping event — missing or invalid timestamp");
            break;
          }
          this.resetHeartbeatMonitor();
          break;
        }
        case "new_message": {
          const data = JSON.parse(rawData) as IncomingMessage;
          if (typeof data.messageId !== "string" || !data.messageId ||
              typeof data.content !== "string" || !data.content) {
            logError("Received malformed new_message — missing or invalid messageId/content");
            break;
          }
          this.processMessage(data);
          break;
        }
        default:
          log(`Unknown event type: ${event}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to parse SSE event "${event}": ${message}`);
    }
  }

  private processMessage(message: IncomingMessage): void {
    if (this.activeHandlers >= MAX_CONCURRENT_HANDLERS) {
      logError(
        `Dropping message ${message.messageId} — concurrency limit reached (${MAX_CONCURRENT_HANDLERS} active handlers)`
      );
      this.sendResponse(
        message.messageId,
        "[Error] Agent is at capacity. Please try again shortly.",
      ).catch(() => {});
      return;
    }

    if (message.images) {
      if (!Array.isArray(message.images)) {
        logError(`Dropping message ${message.messageId} — images field is not an array`);
        return;
      }
      if (message.images.length > MAX_IMAGES_PER_MESSAGE) {
        logError(
          `Dropping message ${message.messageId} — too many images (${message.images.length}, max ${MAX_IMAGES_PER_MESSAGE})`
        );
        return;
      }
      for (const img of message.images) {
        if (typeof img !== "string" || img.length > MAX_IMAGE_SIZE) {
          logError(`Dropping message ${message.messageId} — invalid or oversized image data`);
          return;
        }
      }
    }

    this.activeHandlers++;
    log(`Received message ${message.messageId} from user ${message.userId}`);

    let handlerResult: Promise<string>;
    try {
      handlerResult = this.handler(message);
    } catch (err: unknown) {
      this.activeHandlers--;
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Handler threw synchronously for message ${message.messageId}: ${msg}`);
      return;
    }

    Promise.resolve(handlerResult)
      .then((responseContent) => this.sendResponse(message.messageId, responseContent))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Handler error for message ${message.messageId}: ${msg}`);
      })
      .finally(() => {
        this.activeHandlers--;
      });
  }

  private async sendResponse(messageId: string, content: string): Promise<void> {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(content);
    if (encoded.length > MAX_RESPONSE_SIZE) {
      logError(
        `Response for ${messageId} exceeds 500KB limit (${encoded.length} bytes). Truncating.`
      );
      const truncatedBytes = encoded.slice(0, MAX_RESPONSE_SIZE);
      content = new TextDecoder().decode(truncatedBytes);
      while (content.endsWith("\uFFFD")) {
        content = content.slice(0, -1);
      }
    }

    const url = `${this.config.baseUrl}/respond`;
    const payload: RespondPayload = { messageId, content };

    for (let attempt = 0; attempt <= RESPOND_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(RESPOND_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");

          if (response.status >= 500 && attempt < RESPOND_MAX_RETRIES) {
            logError(
              `Server error sending response for ${messageId}: HTTP ${response.status} (attempt ${attempt + 1}/${RESPOND_MAX_RETRIES + 1}). Retrying...`
            );
            await sleep(RESPOND_RETRY_DELAY_MS * (attempt + 1));
            continue;
          }

          logError(
            `Failed to send response for ${messageId}: HTTP ${response.status} — ${body}`
          );
          return;
        }

        const result = (await response.json()) as RespondResponse;
        if (result.success && result.delivered) {
          log(`Response delivered for message ${messageId}`);
        } else {
          logError(`Response sent but not confirmed for ${messageId}:`, result);
        }
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < RESPOND_MAX_RETRIES) {
          logError(
            `Network error sending response for ${messageId} (attempt ${attempt + 1}/${RESPOND_MAX_RETRIES + 1}): ${msg}. Retrying...`
          );
          await sleep(RESPOND_RETRY_DELAY_MS * (attempt + 1));
        } else {
          logError(
            `Network error sending response for ${messageId} after ${RESPOND_MAX_RETRIES + 1} attempts: ${msg}`
          );
        }
      }
    }
  }

  private startHeartbeatMonitor(): void {
    this.resetHeartbeatMonitor();
  }

  private resetHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      if (this.state !== "connected") return;
      log("Heartbeat timeout — no ping received for 60s. Reconnecting...");
      this.cleanup();
      this.scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested) return;
    if (this.state === "auth_failed") return;
    if (!this.config.autoReconnect) {
      log("Auto-reconnect disabled. Staying disconnected.");
      this.state = "disconnected";
      this.emitSafe("onDisconnect", "connection_lost");
      if (this.connectReject) {
        this.connectReject(new Error("Connection lost and auto-reconnect is disabled"));
        this.connectResolve = null;
        this.connectReject = null;
      }
      return;
    }

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      const err = new Error(
        `Max reconnect attempts reached (${MAX_RECONNECT_ATTEMPTS}). Giving up.`
      );
      logError(err.message);
      this.state = "disconnected";
      this.emitSafe("onError", err);
      this.emitSafe("onDisconnect", "max_reconnect_attempts");
      if (this.connectReject) {
        this.connectReject(err);
        this.connectResolve = null;
        this.connectReject = null;
      }
      return;
    }

    this.state = "reconnecting";
    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);

    this.reconnectTimer = setTimeout(() => {
      this.openStream().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Reconnect stream error: ${msg}`);
      });
    }, delay);
  }

  private emitSafe<K extends keyof ArkitekRelayEvents>(
    event: K,
    ...args: Parameters<NonNullable<ArkitekRelayEvents[K]>>
  ): void {
    try {
      const handler = this.events[event];
      if (handler) {
        (handler as (...a: unknown[]) => void)(...args);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`User callback "${event}" threw: ${msg}`);
    }
  }
}
