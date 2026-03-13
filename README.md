# arkitek-relay-skill

Connect your self-hosted [OpenClaw](https://github.com/openclaw) agent to [ArkiTek](https://arkitek.dev) — a modern web UI for interacting with AI agents. This skill opens a persistent, outbound-only SSE connection from your agent to ArkiTek's cloud relay, so users can chat with your agent through ArkiTek's interface. No tunnels, public URLs, or open ports required.

## How It Works

```
ArkiTek Web UI  ←→  ArkiTek Cloud  ←——SSE——  Your Agent (this skill)
    (user)            (relay)         ——POST→
```

1. Your agent connects **outbound** to ArkiTek over HTTPS
2. Messages from the ArkiTek UI are delivered to your agent via SSE (Server-Sent Events)
3. Your agent processes each message and sends the response back via HTTPS POST
4. ArkiTek delivers the response to the user's browser in real time

The agent initiates all connections. Nothing is exposed on your network.

## Prerequisites

- **Node.js 18+** (uses native `fetch` and `ReadableStream`)
- An **OpenClaw agent** (or any agent framework — the handler interface is generic)
- An **ArkiTek account** at [arkitek.dev](https://arkitek.dev)

## Quick Start

```bash
npm install arkitek-relay-skill
npx arkitek-relay-skill
```

That's it. The skill will ask for your API key, save it, and connect your agent to ArkiTek automatically.

> **First time?** Get your API key at [arkitek.dev](https://arkitek.dev) — go to **Agents** → **Add Agent** → **Create** and copy the `ak_...` key.

## What Happens When You Run It

1. If no API key is saved, the skill prompts you to paste one
2. The key is validated and saved to a local `.env` file (so you never have to enter it again)
3. The skill connects to ArkiTek over HTTPS
4. Your agent is live — send it a message from the ArkiTek UI

On subsequent runs, the saved key is loaded automatically and the agent reconnects.

## Changing or Rotating Your API Key

1. Stop the agent (Ctrl+C)
2. Delete or edit the `ARKITEK_API_KEY` line in your `.env` file
3. Run `npx arkitek-relay-skill` again — it will prompt for the new key

If you deleted your agent in ArkiTek and want to reconnect, create a new agent in the dashboard, copy the new key, and follow the steps above.

## Disconnecting Your Agent

1. Stop the agent process — this closes the connection to ArkiTek
2. Optionally delete the agent in ArkiTek's dashboard (**Agents** → select your agent → **Delete**)

The skill files remain installed locally. To fully remove: `npm uninstall arkitek-relay-skill`

## Configuration Options

The skill reads these from your `.env` file or environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ARKITEK_API_KEY` | Yes | — | Your agent's private API key from ArkiTek |
| `ARKITEK_AUTO_RECONNECT` | No | `true` | Auto-reconnect on network errors |

> **Security**: Your API key is a secret. The `.env` file is local only — never commit it to version control or share it publicly.

## Advanced: Using as a Library

If you're building your own agent and want to integrate the relay programmatically:

```typescript
import { createArkitekRelay } from "arkitek-relay-skill";
import type { IncomingMessage } from "arkitek-relay-skill";

async function handleMessage(message: IncomingMessage): Promise<string> {
  const response = await yourAgent.process(message.content, message.images);
  return response;
}

const relay = createArkitekRelay(
  { apiKey: process.env.ARKITEK_API_KEY! },
  handleMessage,
  {
    onConnect: (agentId) => console.log(`Connected as agent ${agentId}`),
    onDisconnect: (reason) => console.log(`Disconnected: ${reason}`),
    onError: (err) => console.error(`Error: ${err.message}`),
  }
);

await relay.connect();
```

## Council of LLMs (Optional)

ArkiTek's Council feature lets you query multiple LLMs simultaneously and get aggregated responses. This requires an active ArkiTek subscription.

```typescript
import { queryCouncil } from "arkitek-relay-skill";

const result = await queryCouncil(
  { apiKey: process.env.ARKITEK_API_KEY! },
  "What are the security implications of SSE vs WebSockets?",
  ["gpt-4", "claude-3"] // optional — omit to use defaults
);

for (const r of result.responses) {
  console.log(`${r.modelId}: ${r.response}`);
}
```

**Limits**: 10 requests per minute, prompt max 100KB, max 8 models per request.

## Message Format

### Incoming messages (from ArkiTek)

```typescript
interface IncomingMessage {
  messageId: string;   // Unique ID — must be included in your response
  content: string;     // The user's message text
  images?: string[];   // Optional base64-encoded images
  userId: string;      // The ArkiTek user's ID
  timestamp: string;   // ISO 8601 timestamp
}
```

### Your handler's return value

Return a `string` — the agent's response text. The skill handles sending it back to ArkiTek with the correct `messageId`.

## Security

This skill is designed with security as a top priority:

- **Outbound-only connections** — your agent never exposes any ports or URLs
- **TLS enforced** — the skill refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is detected
- **API key validation** — keys are validated against the expected format before any network request
- **Key masking** — API keys are never logged; only `ak_****...last4` appears in output
- **No tunnels** — no ngrok, no Cloudflare tunnels, no port forwarding
- **Auth on every request** — both SSE and POST endpoints require the Bearer token
- **Message integrity** — responses must include the matching `messageId` or they are rejected

## Troubleshooting

### "API key invalid or revoked"

- Double-check your `ARKITEK_API_KEY` value
- Verify the key in ArkiTek's dashboard — it may have been revoked
- Keys start with `ak_` and are exactly 67 characters
- If you rotated your key, the old key has a 1-hour grace period

### "NODE_TLS_REJECT_UNAUTHORIZED=0 detected"

- Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` from your environment
- This setting disables TLS certificate verification, which would allow man-in-the-middle attacks
- If you're behind a corporate proxy, configure `NODE_EXTRA_CA_CERTS` instead

### Connection keeps dropping

- Check your network connection and firewall rules
- Ensure outbound HTTPS (port 443) to `arkitek.dev` is allowed
- The skill auto-reconnects with exponential backoff (1s → 30s max)
- Messages are queued server-side for up to 5 minutes during disconnections

### "Response not delivered"

- Ensure you're returning from your handler within 1 hour (server timeout)
- The `messageId` in your response must exactly match the incoming message
- Response content must be under 500KB

### No messages arriving

- Confirm your agent shows as "Connected" in the ArkiTek dashboard
- Try sending a test message from the ArkiTek web UI
- Check that your handler isn't throwing errors (they're caught and logged)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode (rebuilds on changes)
npm run dev
```

## License

MIT — see [LICENSE](LICENSE).
