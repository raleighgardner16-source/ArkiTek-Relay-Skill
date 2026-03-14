import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { RelayClient } from "../src/relay.js";
import { maskKey, validateApiKey, checkTlsSafety, warnIfNotHttps } from "../src/validation.js";
import type { IncomingMessage as NodeIncomingMessage, ServerResponse } from "node:http";

const VALID_KEY = "ak_" + "a".repeat(64);

function createMockSSEServer(): {
  server: http.Server;
  port: number;
  connections: ServerResponse[];
  start: () => Promise<number>;
  close: () => Promise<void>;
  sendEvent: (event: string, data: string) => void;
  lastAuthHeader: string | undefined;
  respondRequests: Array<{ messageId: string; content: string }>;
  respondAttempts: number;
  authBehavior: "accept" | "reject_401" | "reject_403";
  respondBehavior: "success" | "server_error_then_success";
} {
  const connections: ServerResponse[] = [];
  const respondRequests: Array<{ messageId: string; content: string }> = [];
  let respondAttempts = 0;
  let lastAuthHeader: string | undefined;
  let authBehavior: "accept" | "reject_401" | "reject_403" = "accept";
  let respondBehavior: "success" | "server_error_then_success" = "success";
  let port = 0;

  const server = http.createServer(
    (req: NodeIncomingMessage, res: ServerResponse) => {
      lastAuthHeader = req.headers.authorization;

      if (req.url?.endsWith("/stream")) {
        if (authBehavior === "reject_401") {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        if (authBehavior === "reject_403") {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        connections.push(res);

        res.write(
          `event: connected\ndata: ${JSON.stringify({ agentId: "test-agent-123", timestamp: new Date().toISOString() })}\n\n`
        );

        req.on("close", () => {
          const idx = connections.indexOf(res);
          if (idx >= 0) connections.splice(idx, 1);
        });
        return;
      }

      if (req.url?.endsWith("/respond") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          respondAttempts++;

          if (respondBehavior === "server_error_then_success" && respondAttempts <= 2) {
            res.writeHead(503);
            res.end("Service Unavailable");
            return;
          }

          try {
            const parsed = JSON.parse(body);
            respondRequests.push(parsed);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, delivered: true }));
          } catch {
            res.writeHead(400);
            res.end("Bad request");
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    }
  );

  function sendEvent(event: string, data: string): void {
    for (const conn of connections) {
      conn.write(`event: ${event}\ndata: ${data}\n\n`);
    }
  }

  async function start(): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(port);
      });
    });
  }

  async function close(): Promise<void> {
    for (const conn of connections) {
      conn.end();
    }
    connections.length = 0;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    server,
    get port() { return port; },
    connections,
    start,
    close,
    sendEvent,
    get lastAuthHeader() { return lastAuthHeader; },
    respondRequests,
    get respondAttempts() { return respondAttempts; },
    get authBehavior() { return authBehavior; },
    set authBehavior(v) { authBehavior = v; },
    get respondBehavior() { return respondBehavior; },
    set respondBehavior(v) { respondAttempts = 0; respondBehavior = v; },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("maskKey", () => {
  it("masks a valid API key", () => {
    const masked = maskKey(VALID_KEY);
    expect(masked).toBe("ak_****...aaaa");
    expect(masked).not.toContain(VALID_KEY);
  });

  it("handles short/empty keys", () => {
    expect(maskKey("")).toBe("ak_****");
    expect(maskKey("short")).toBe("ak_****");
  });
});

describe("validateApiKey", () => {
  it("accepts a valid key", () => {
    expect(() => validateApiKey(VALID_KEY)).not.toThrow();
  });

  it("rejects empty key", () => {
    expect(() => validateApiKey("")).toThrow("ARKITEK_API_KEY is required");
  });

  it("rejects key without ak_ prefix", () => {
    expect(() => validateApiKey("xx_" + "a".repeat(64))).toThrow("Invalid API key format");
  });

  it("rejects key with wrong length", () => {
    expect(() => validateApiKey("ak_" + "a".repeat(10))).toThrow("Invalid API key format");
  });

  it("rejects key with special characters", () => {
    expect(() => validateApiKey("ak_" + "a".repeat(63) + "!")).toThrow(
      "Invalid API key format"
    );
  });
});

describe("checkTlsSafety", () => {
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    }
  });

  it("throws when TLS verification is disabled", () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    expect(() => checkTlsSafety()).toThrow("NODE_TLS_REJECT_UNAUTHORIZED=0 detected");
  });

  it("passes when TLS verification is enabled", () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(() => checkTlsSafety()).not.toThrow();
  });
});

describe("RelayClient", () => {
  let mock: ReturnType<typeof createMockSSEServer>;

  beforeEach(async () => {
    mock = createMockSSEServer();
    await mock.start();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("rejects construction with invalid API key", () => {
    expect(
      () => new RelayClient({ apiKey: "bad-key" }, async () => "")
    ).toThrow("Invalid API key format");
  });

  it("rejects construction when TLS is disabled", () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      expect(
        () => new RelayClient({ apiKey: VALID_KEY }, async () => "")
      ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED=0");
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  });

  it("connects and receives connected event", async () => {
    const onConnect = vi.fn();
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      { onConnect }
    );

    await client.connect();

    expect(client.isConnected()).toBe(true);
    expect(onConnect).toHaveBeenCalledWith("test-agent-123");

    client.disconnect();
  });

  it("sends Bearer auth header", async () => {
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => ""
    );

    await client.connect();

    expect(mock.lastAuthHeader).toBe(`Bearer ${VALID_KEY}`);

    client.disconnect();
  });

  it("receives new_message and sends response", async () => {
    const handler = vi.fn(async () => "Hello back!");
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-001",
        content: "Hello agent",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );

    await wait(300);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].messageId).toBe("msg-001");
    expect(handler.mock.calls[0][0].content).toBe("Hello agent");

    expect(mock.respondRequests).toHaveLength(1);
    expect(mock.respondRequests[0].messageId).toBe("msg-001");
    expect(mock.respondRequests[0].content).toBe("Hello back!");

    client.disconnect();
  });

  it("handles messages with images", async () => {
    const handler = vi.fn(async () => "Got it");
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-002",
        content: "Look at this",
        images: ["base64data1", "base64data2"],
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );

    await wait(300);

    expect(handler.mock.calls[0][0].images).toEqual(["base64data1", "base64data2"]);

    client.disconnect();
  });

  it("stops reconnecting on 401", async () => {
    mock.authBehavior = "reject_401";
    const onError = vi.fn();

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      { onError }
    );

    await expect(client.connect()).rejects.toThrow("API key invalid or revoked");

    expect(client.getState()).toBe("auth_failed");
    expect(onError).toHaveBeenCalled();
  });

  it("stops reconnecting on 403", async () => {
    mock.authBehavior = "reject_403";
    const onError = vi.fn();

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      { onError }
    );

    await expect(client.connect()).rejects.toThrow("API key invalid or revoked");

    expect(client.getState()).toBe("auth_failed");
  });

  it("reconnects on network error", async () => {
    const client = new RelayClient(
      {
        apiKey: VALID_KEY,
        baseUrl: `http://localhost:${mock.port}`,
        autoReconnect: true,
      },
      async () => ""
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);

    for (const conn of mock.connections) {
      conn.destroy();
    }

    await wait(2500);

    expect(
      client.getState() === "connected" ||
        client.getState() === "reconnecting" ||
        client.getState() === "connecting"
    ).toBe(true);

    client.disconnect();
  });

  it("does not crash on malformed SSE data", async () => {
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => ""
    );

    await client.connect();

    mock.sendEvent("new_message", "{invalid json!!!");
    mock.sendEvent("new_message", "");
    mock.sendEvent("unknown_event", "{}");

    await wait(200);

    expect(client.isConnected()).toBe(true);

    client.disconnect();
  });

  it("never crashes on handler errors", async () => {
    const handler = vi.fn(async () => {
      throw new Error("Handler exploded");
    });

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-crash",
        content: "trigger error",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );

    await wait(200);

    expect(client.isConnected()).toBe(true);
    expect(handler).toHaveBeenCalled();
    expect(mock.respondRequests).toHaveLength(0);

    client.disconnect();
  });

  it("does not reconnect when autoReconnect is false", async () => {
    const client = new RelayClient(
      {
        apiKey: VALID_KEY,
        baseUrl: `http://localhost:${mock.port}`,
        autoReconnect: false,
      },
      async () => ""
    );

    await client.connect();

    for (const conn of mock.connections) {
      conn.destroy();
    }

    await wait(1500);

    expect(client.getState()).toBe("disconnected");
  });

  it("calls onDisconnect on manual disconnect", async () => {
    const onDisconnect = vi.fn();
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      { onDisconnect }
    );

    await client.connect();

    client.disconnect("user requested");

    expect(onDisconnect).toHaveBeenCalledWith("user requested");
  });

  it("survives a throwing onConnect callback", async () => {
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      {
        onConnect: () => {
          throw new Error("onConnect exploded");
        },
      }
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);

    client.disconnect();
  });

  it("survives a throwing onDisconnect callback", async () => {
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      {
        onDisconnect: () => {
          throw new Error("onDisconnect exploded");
        },
      }
    );

    await client.connect();
    expect(() => client.disconnect()).not.toThrow();
    expect(client.getState()).toBe("disconnected");
  });

  it("survives a throwing onError callback on auth failure", async () => {
    mock.authBehavior = "reject_401";

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => "",
      {
        onError: () => {
          throw new Error("onError exploded");
        },
      }
    );

    await expect(client.connect()).rejects.toThrow("API key invalid or revoked");
    expect(client.getState()).toBe("auth_failed");
  });

  it("rejects malformed connected event with missing agentId", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const badServer = http.createServer(
      (req: NodeIncomingMessage, res: ServerResponse) => {
        if (req.url?.endsWith("/stream")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(
            `event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`
          );
          return;
        }
        res.writeHead(404);
        res.end();
      }
    );

    const port = await new Promise<number>((resolve) => {
      badServer.listen(0, () => {
        const addr = badServer.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      const client = new RelayClient(
        {
          apiKey: VALID_KEY,
          baseUrl: `http://localhost:${port}`,
          autoReconnect: false,
        },
        async () => ""
      );

      const connectPromise = client.connect();
      await wait(500);

      expect(client.isConnected()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("malformed connected event")
      );

      client.disconnect();
      await connectPromise.catch(() => {});
    } finally {
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => badServer.close(() => resolve()));
    }
  });

  it("rejects malformed ping event with non-numeric timestamp", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => ""
    );

    await client.connect();

    mock.sendEvent("ping", JSON.stringify({ t: "not-a-number" }));
    await wait(200);

    expect(client.isConnected()).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("malformed ping event")
    );

    errorSpy.mockRestore();
    client.disconnect();
  });

  it("throws on connect() after auth_failed state", async () => {
    mock.authBehavior = "reject_401";
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      async () => ""
    );

    await expect(client.connect()).rejects.toThrow("API key invalid or revoked");
    expect(client.getState()).toBe("auth_failed");

    await expect(client.connect()).rejects.toThrow("Cannot connect");
  });

  it("recovers activeHandlers after synchronous handler throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    const handler = vi.fn((_msg) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("sync boom");
      }
      return Promise.resolve("ok");
    });

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-sync-throw",
        content: "trigger sync error",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );
    await wait(200);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Handler threw synchronously")
    );

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-after-throw",
        content: "should still work",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );
    await wait(300);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(mock.respondRequests).toHaveLength(1);
    expect(mock.respondRequests[0].messageId).toBe("msg-after-throw");

    errorSpy.mockRestore();
    client.disconnect();
  });

  it("gracefulDisconnect waits for in-flight handlers", async () => {
    let resolveHandler: (() => void) | null = null;
    const handler = vi.fn(() => {
      return new Promise<string>((resolve) => {
        resolveHandler = () => resolve("delayed response");
      });
    });

    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-drain",
        content: "slow message",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );
    await wait(100);
    expect(handler).toHaveBeenCalledOnce();

    const drainPromise = client.gracefulDisconnect("test drain");

    await wait(200);
    expect(client.getState()).not.toBe("disconnected");

    resolveHandler!();
    await drainPromise;

    expect(client.getState()).toBe("disconnected");
    expect(mock.respondRequests).toHaveLength(1);
    expect(mock.respondRequests[0].content).toBe("delayed response");
  });

  it("retries on 5xx respond errors then succeeds", async () => {
    mock.respondBehavior = "server_error_then_success";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = vi.fn(async () => "retry response");
    const client = new RelayClient(
      { apiKey: VALID_KEY, baseUrl: `http://localhost:${mock.port}` },
      handler
    );

    await client.connect();

    mock.sendEvent(
      "new_message",
      JSON.stringify({
        messageId: "msg-5xx",
        content: "trigger 5xx",
        userId: "user-1",
        timestamp: new Date().toISOString(),
      })
    );

    await wait(5000);

    expect(mock.respondAttempts).toBeGreaterThan(1);
    expect(mock.respondRequests).toHaveLength(1);
    expect(mock.respondRequests[0].content).toBe("retry response");

    errorSpy.mockRestore();
    client.disconnect();
  });
});

describe("warnIfNotHttps", () => {
  it("warns for each distinct non-HTTPS URL", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnIfNotHttps("http://insecure-1.example.com");
    warnIfNotHttps("http://insecure-2.example.com");
    warnIfNotHttps("http://insecure-1.example.com");

    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it("does not warn for localhost or 127.0.0.1", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnIfNotHttps("http://localhost:3000");
    warnIfNotHttps("http://127.0.0.1:3000");

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe("Council client", () => {
  let queryCouncil: typeof import("../src/council.js")["queryCouncil"];

  beforeAll(async () => {
    const mod = await import("../src/council.js");
    queryCouncil = mod.queryCouncil;
  });

  it("rejects prompt exceeding 100KB", async () => {
    const longPrompt = "x".repeat(100 * 1024 + 1);
    await expect(
      queryCouncil({ apiKey: VALID_KEY }, longPrompt)
    ).rejects.toThrow("exceeds 100KB limit");
  });

  it("rejects more than 8 models", async () => {
    const models = Array.from({ length: 9 }, (_, i) => `model-${i}`);
    await expect(
      queryCouncil({ apiKey: VALID_KEY }, "test", models)
    ).rejects.toThrow("exceeds 8 model limit");
  });

  it("rejects invalid API key", async () => {
    await expect(
      queryCouncil({ apiKey: "bad-key" }, "test")
    ).rejects.toThrow("Invalid API key format");
  });

  it("rejects empty API key", async () => {
    await expect(
      queryCouncil({ apiKey: "" }, "test")
    ).rejects.toThrow("ARKITEK_API_KEY is required");
  });

  it("rejects when TLS verification is disabled", async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(
        queryCouncil({ apiKey: VALID_KEY }, "test")
      ).rejects.toThrow("NODE_TLS_REJECT_UNAUTHORIZED=0 detected");
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  });
});
