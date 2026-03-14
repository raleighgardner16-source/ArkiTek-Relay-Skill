---
name: arkitek-relay
description: Connect this agent to ArkiTek for secure remote chat via SSE. No tunnels, no open ports.
metadata: {"openclaw": {"requires": {"env": ["ARKITEK_API_KEY"], "bins": ["node", "npx"]}, "primaryEnv": "ARKITEK_API_KEY", "emoji": "\uD83D\uDCE1", "homepage": "https://arkitekai.com", "install": [{"id": "npm", "kind": "node", "package": "arkitek-relay-skill", "bins": ["arkitek-relay-skill"], "label": "Install ArkiTek Relay (npm)"}]}}
---

# ArkiTek Relay Skill

This skill connects your OpenClaw agent to [ArkiTek](https://arkitekai.com) — a web UI for chatting with AI agents remotely. It opens a secure, outbound-only SSE connection from your agent to ArkiTek's cloud relay, and forwards incoming messages directly to your OpenClaw gateway. No tunnels, public URLs, or open ports required.

## Quick Start

1. Install the relay:

```
npm install -g arkitek-relay-skill
```

2. Get your API key from [arkitekai.com](https://arkitekai.com) (Agents → Add Agent → Create)

3. Run the relay:

```
npx arkitek-relay-skill
```

On first run, the relay will:
- Auto-detect your OpenClaw installation and gateway config
- Place the skill definition (`SKILL.md`) into OpenClaw's skills directory
- Prompt for your ArkiTek API key
- Test the gateway connection
- Check that `/v1/responses` is enabled (and offer to enable it if not)
- Save configuration to `~/.arkitek-relay/config.json`
- Offer to install as a system service (auto-start on boot)
- Connect to ArkiTek

Subsequent runs load the saved config automatically.

## Commands

```
npx arkitek-relay-skill               Start the relay (guided setup on first run)
npx arkitek-relay-skill --install     Re-run guided setup
npx arkitek-relay-skill --init-skill  Place SKILL.md into OpenClaw's skills directory
npx arkitek-relay-skill --doctor      Run diagnostic checks
npx arkitek-relay-skill --status      Show saved configuration
npx arkitek-relay-skill --logs        View relay log output
npx arkitek-relay-skill --uninstall   Remove service and saved config
npx arkitek-relay-skill --help        Show all options
```

## Manual Setup (Advanced)

If you prefer manual configuration, set these environment variables or pass them as CLI flags:

```
ARKITEK_API_KEY=ak_your_key_here
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_token_here
```

Make sure the `/v1/responses` endpoint is enabled in OpenClaw:

```
openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true
```

Then start the relay:

```
npx arkitek-relay-skill
```

## How it works

```
ArkiTek Web UI  ←→  ArkiTek Cloud  ←——SSE——  This Skill  ——POST→  OpenClaw Gateway
    (user)            (relay)                  (bridge)             (your agent)
```

All connections are outbound from the agent. Nothing is exposed on the agent's network.

## Skill Definition Placement

During setup, the relay automatically places its `SKILL.md` into OpenClaw's skills directory so your agent can discover it:

- Default location: `~/.openclaw/skills/arkitek-relay/SKILL.md`
- Custom directory: `--skills-dir <path>` overrides the default
- The `--init-skill` command can re-run this step independently

OpenClaw will discover the skill on next load. Verify with `openclaw skills list`.

## Config Resolution

The relay resolves configuration from multiple sources (highest priority first):

1. CLI flags (`--api-key`, `--gateway-url`, `--gateway-token`)
2. Environment variables (`ARKITEK_API_KEY`, `OPENCLAW_GATEWAY_URL`, etc.)
3. Saved config (`~/.arkitek-relay/config.json`)
4. Auto-detected from OpenClaw (`~/.openclaw/openclaw.json`)
5. Defaults

The gateway token is never saved to disk — it's always read live from CLI, environment, or OpenClaw's config so key rotations are picked up automatically.

## System Service

During setup, the relay offers to install as a system service that starts automatically on boot:

- **macOS**: LaunchAgent (`~/Library/LaunchAgents/com.arkitekai.relay.plist`)
- **Linux**: systemd user unit (`~/.config/systemd/user/arkitek-relay.service`)
- **Windows**: Scheduled task (runs at logon)

The service is user-scoped (no root/admin required), keeps the relay running in the background, and auto-restarts on crashes. Remove it anytime with `--uninstall`.

## Security

- Outbound-only HTTPS connections — no open ports or public URLs
- TLS enforced — refuses to run if TLS verification is disabled
- API key validated before any network request
- API keys are never logged (masked as `ak_****...last4`)
- OpenClaw config is read with ownership and permission checks
- Gateway token is never persisted — always read live
- System service is user-scoped — no elevated privileges required

## Troubleshooting

**Relay shows "Echo mode":**
- Run `npx arkitek-relay-skill --doctor` to diagnose
- Check that OpenClaw gateway is running
- Verify `/v1/responses` endpoint is enabled in OpenClaw config

**Agent offline in ArkiTek:**
- Check relay status: `npx arkitek-relay-skill --doctor`
- Verify internet connectivity to arkitekai.com
- Restart: `npx arkitek-relay-skill`

**"API key invalid or revoked":**
- Run `npx arkitek-relay-skill --install` to reconfigure
- Verify the key in ArkiTek's dashboard
