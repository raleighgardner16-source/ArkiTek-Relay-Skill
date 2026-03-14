---
name: arkitek-relay
description: Connect this agent to ArkiTek for secure remote chat via SSE. No tunnels, no open ports.
metadata: {"openclaw": {"requires": {"env": ["ARKITEK_API_KEY"], "bins": ["node", "npx"]}, "primaryEnv": "ARKITEK_API_KEY", "emoji": "📡", "homepage": "https://arkitekai.com", "install": [{"id": "npm", "kind": "node", "package": "arkitek-relay-skill", "bins": ["arkitek-relay-skill"], "label": "Install ArkiTek Relay (npm)"}]}}
---

# ArkiTek Relay Skill

This skill connects your OpenClaw agent to [ArkiTek](https://arkitekai.com) — a web UI for chatting with AI agents remotely. It opens a secure, outbound-only SSE connection from your agent to ArkiTek's cloud relay, and forwards incoming messages directly to your OpenClaw gateway. No tunnels, public URLs, or open ports required.

## Setup

1. Get your API key from [arkitekai.com](https://arkitekai.com) (Agents → Add Agent → Create)
2. Set the environment variable:

```
ARKITEK_API_KEY=ak_your_key_here
```

3. Start the relay:

```
npx arkitek-relay-skill
```

The skill auto-detects your OpenClaw gateway on `localhost:18789`. If you use a non-default port or require a token, also set:

```
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_token_here
```

## When to use this skill

- Use this skill when you want users to chat with you through the ArkiTek web interface
- Run `npx arkitek-relay-skill` in the background to maintain the connection
- Messages from ArkiTek are forwarded to your OpenClaw gateway and responses are sent back automatically
- The connection auto-reconnects if it drops

## How it works

```
ArkiTek Web UI  ←→  ArkiTek Cloud  ←——SSE——  This Skill  ——POST→  OpenClaw Gateway
    (user)            (relay)                  (bridge)             (your agent)
```

All connections are outbound from the agent. Nothing is exposed on the agent's network.

## Security

- Outbound-only HTTPS connections — no open ports or public URLs
- TLS enforced — refuses to run if TLS verification is disabled
- API key validated before any network request
- API keys are never logged
