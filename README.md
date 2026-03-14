# arkitek-relay-skill

Connect your self-hosted [OpenClaw](https://github.com/openclaw) agent to [ArkiTek](https://arkitekai.com) — a modern web UI for interacting with AI agents. This skill opens a persistent, outbound-only SSE connection from your agent to ArkiTek's cloud relay, so users can chat with your agent through ArkiTek's interface. No tunnels, public URLs, or open ports required.

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
- An **ArkiTek account** at [arkitekai.com](https://arkitekai.com)

## Quick Start

```bash
npm install -g arkitek-relay-skill
npx arkitek-relay-skill
```

On first run, the relay will:

1. Auto-detect your OpenClaw installation (`~/.openclaw/openclaw.json`)
2. Find your gateway URL, port, and auth token automatically
3. Place the skill definition (`SKILL.md`) into OpenClaw's skills directory
4. Prompt for your ArkiTek API key (saved for future runs)
5. Test the gateway connection and check that `/v1/responses` is enabled
6. Offer to enable it if it's disabled
7. Save configuration to `~/.arkitek-relay/config.json`
8. Offer to install as a system service (auto-start on boot)
9. Connect your agent to ArkiTek

> **First time?** Get your API key at [arkitekai.com](https://arkitekai.com) — go to **Agents** → **Add Agent** → **Create** and copy the `ak_...` key.

On subsequent runs, the saved config is loaded automatically and the agent reconnects.

## Commands

| Command | Description |
|---------|-------------|
| `npx arkitek-relay-skill` | Start the relay (guided setup on first run) |
| `npx arkitek-relay-skill --install` | Re-run guided setup |
| `npx arkitek-relay-skill --init-skill` | Place SKILL.md into OpenClaw's skills directory |
| `npx arkitek-relay-skill --doctor` | Run diagnostic checks on your setup |
| `npx arkitek-relay-skill --status` | Show saved configuration |
| `npx arkitek-relay-skill --logs` | View relay log output |
| `npx arkitek-relay-skill --uninstall` | Remove service and saved config |
| `npx arkitek-relay-skill --help` | Show all options |

### CLI Options

| Option | Description |
|--------|-------------|
| `--api-key <key>` | ArkiTek API key (overrides saved config) |
| `--gateway-url <url>` | OpenClaw gateway URL (overrides auto-detection) |
| `--gateway-token <token>` | OpenClaw gateway auth token |
| `--agent-id <id>` | OpenClaw agent ID (default: `"main"`) |
| `--skills-dir <path>` | Custom OpenClaw skills directory for SKILL.md placement |
| `--yes, -y` | Skip confirmation prompts |
| `--verbose, -v` | Show detailed output |

## Skill Definition (SKILL.md)

During setup, the relay places its skill definition file into OpenClaw's skills directory so your agent can automatically discover it:

- **Default location**: `~/.openclaw/skills/arkitek-relay/SKILL.md`
- **Custom directory**: use `--skills-dir <path>` to override
- **Standalone command**: `npx arkitek-relay-skill --init-skill`

If OpenClaw has custom skill directories configured via `skills.load.extraDirs` in `openclaw.json`, the relay checks those locations too. You can verify with `openclaw skills list`.

## Config Resolution

The relay resolves configuration from multiple sources (highest priority first):

1. **CLI flags** (`--api-key`, `--gateway-url`, `--gateway-token`)
2. **Environment variables** (`ARKITEK_API_KEY`, `OPENCLAW_GATEWAY_URL`, etc.)
3. **Saved config** (`~/.arkitek-relay/config.json`, created by `--install`)
4. **Auto-detected from OpenClaw** (`~/.openclaw/openclaw.json`)
5. **Defaults**

The gateway token is **never saved to disk** — it's always read live from the CLI, environment, or OpenClaw's own config file so key rotations are picked up automatically.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ARKITEK_API_KEY` | Yes | — | Your agent's private API key from ArkiTek |
| `ARKITEK_RELAY_URL` | No | `https://api.arkitekai.com/api/v1/agents/relay` | Relay server URL |
| `ARKITEK_AUTO_RECONNECT` | No | `true` | Auto-reconnect on network errors |
| `OPENCLAW_GATEWAY_URL` | No | Auto-detected | OpenClaw gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | No | Auto-detected | Bearer token for OpenClaw gateway auth |
| `OPENCLAW_AGENT_ID` | No | `main` | OpenClaw agent ID |

> **Security**: Your API key is a secret. Never commit it to version control or share it publicly.

## Changing or Rotating Your API Key

1. Run `npx arkitek-relay-skill --install` — it will detect the existing key and let you replace it
2. Or set the `ARKITEK_API_KEY` environment variable directly
3. Or use `--api-key <new_key>` on the command line

## System Service (Auto-Start)

During setup, the relay offers to install as a system service that starts automatically on boot and restarts on crashes. No terminal needed.

| Platform | Service type | Location |
|----------|-------------|----------|
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.arkitekai.relay.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/arkitek-relay.service` |
| Windows | Scheduled task | `ArkiTekRelay` (runs at logon) |

The service is **user-scoped** — no root, sudo, or admin privileges are required. It runs as your user account with the same permissions as running the relay manually in a terminal.

To check the service:
```bash
npx arkitek-relay-skill --status    # shows if installed and running
npx arkitek-relay-skill --logs      # view service log output
npx arkitek-relay-skill --doctor    # full diagnostic including service
```

To remove the service:
```bash
npx arkitek-relay-skill --uninstall
```

> **Note**: For the service to persist across reboots, install the package globally: `npm install -g arkitek-relay-skill`. If you run via `npx` without a global install, the cached package may be cleaned up.

## Disconnecting Your Agent

1. Stop the agent process — if running as a service, use `npx arkitek-relay-skill --uninstall`; if running manually, press Ctrl+C
2. Optionally delete the agent in ArkiTek's dashboard (**Agents** → select your agent → **Delete**)
3. To remove all local config and service: `npx arkitek-relay-skill --uninstall`
4. To fully remove the package: `npm uninstall -g arkitek-relay-skill`

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

You can also use the config resolver programmatically:

```typescript
import { resolveConfig, detectOpenClaw } from "arkitek-relay-skill";

// Auto-detect OpenClaw and resolve all config sources
const config = resolveConfig({ command: "start" });
// config.gatewayUrl, config.gatewayToken, etc. are resolved from
// CLI → env → saved config → OpenClaw → defaults
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
- **Secure config reading** — OpenClaw config is read with file ownership and permission checks
- **Token hygiene** — gateway tokens are never persisted to disk; always read live from source
- **User-scoped service** — system service runs as your user, no root/admin required

## Troubleshooting

### Run the doctor

The fastest way to diagnose any issue:

```bash
npx arkitek-relay-skill --doctor
```

This checks Node.js version, saved config, API key, OpenClaw detection, gateway reachability, `/v1/responses` endpoint status, ArkiTek cloud connectivity, system service status, and SKILL.md placement.

### "Mode: Echo" — relay not forwarding to OpenClaw

- Run `--doctor` to see what's wrong
- Ensure OpenClaw is running: `openclaw gateway start`
- Verify `/v1/responses` is enabled: `openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true`
- Restart the relay

### "API key invalid or revoked"

- Run `npx arkitek-relay-skill --install` to enter a new key
- Verify the key in ArkiTek's dashboard — it may have been revoked
- Keys start with `ak_` and are exactly 67 characters

### "NODE_TLS_REJECT_UNAUTHORIZED=0 detected"

- Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` from your environment
- If you're behind a corporate proxy, configure `NODE_EXTRA_CA_CERTS` instead

### Connection keeps dropping

- Check your network connection and firewall rules
- Ensure outbound HTTPS (port 443) to `arkitekai.com` is allowed
- The skill auto-reconnects with exponential backoff (1s → 30s max)

## Development

```bash
npm install
npm run build
npm test
npm run dev     # watch mode
```

## License

MIT — see [LICENSE](LICENSE).
