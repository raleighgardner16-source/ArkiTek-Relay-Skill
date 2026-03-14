# ArkiTek Relay Skill — App Repo Handoff Document

**Purpose:** This document summarizes the `arkitek-relay-skill` npm package and its v1.0.9 release so backend and UI agents working on the ArkiTek app can align their implementation. Use this as context incase we need to update something in this repo.

---

## 1. What This Package Is

**`arkitek-relay-skill`** is an npm package that runs on the **user's device** (alongside their OpenClaw agent). It acts as a bridge:

```
ArkiTek Web UI  ←→  ArkiTek Cloud (your app)  ←——SSE——  Relay (this package)  ——POST→  OpenClaw Gateway (user's agent)
```

- **Outbound-only:** The relay initiates all connections to ArkiTek. No tunnels, ngrok, or open ports.
- **SSE stream:** Relay opens a long-lived GET request to ArkiTek's relay API and receives `new_message` events.
- **Respond endpoint:** When the agent has a response, the relay POSTs it back to ArkiTek.
- **OpenClaw integration:** The relay auto-detects OpenClaw config, forwards messages to `/v1/responses`, and parses responses.

The app backend must provide:
1. An SSE stream endpoint (`GET /api/v1/agents/relay/stream`) — agent connects with Bearer token
2. A respond endpoint (`POST /api/v1/agents/relay/respond`) — agent sends responses back
3. Optional: Council API (`POST /api/v1/agents/relay/council`) — multi-model query

---

## 2. Backend API Contract (What the Relay Expects)

### Base URL

```
https://api.arkitekai.com/api/v1/agents/relay
```

Override via `ARKITEK_RELAY_URL` env var for testing/staging.

---

### 2.1 SSE Stream — `GET /stream`

**Purpose:** Agent opens this endpoint to receive incoming messages and connection lifecycle events.

**Request:**
- `Authorization: Bearer <ak_...api_key>`
- `Accept: text/event-stream`
- `Cache-Control: no-cache`

**Auth failures:**
- `401` / `403` → Relay stops retrying permanently (auth_failed state). User must fix API key.

**SSE events the relay expects:**

| Event        | JSON payload                                                     | Notes                                                        |
|-------------|------------------------------------------------------------------|--------------------------------------------------------------|
| `connected` | `{ "agentId": string, "timestamp": string }`                      | Emitted once after auth. Relay enters "connected" state.      |
| `ping`      | `{ "t": number }`                                                 | Heartbeat. Relay resets 60s timeout; disconnects if no ping.  |
| `new_message` | See `IncomingMessage` below                                   | User sent a message from the UI. Relay processes and responds.|

**Relay behavior:**
- Connects outbound, waits for `connected` event
- Expects `ping` at least every 60s; disconnects and reconnects if idle
- On `new_message`, runs handler (e.g. forwards to OpenClaw), then POSTs response to `/respond`
- Auto-reconnects on network errors (exponential backoff 1s → 30s, max 50 attempts)
- Does NOT reconnect on 401/403

---

### 2.2 Respond — `POST /respond`

**Purpose:** Agent sends the text response back to ArkiTek after processing a message.

**Request:**
- `Authorization: Bearer <ak_...api_key>`
- `Content-Type: application/json`
- Body: `{ "messageId": string, "content": string }`

**Expected response:**
```json
{ "success": boolean, "delivered": boolean }
```

**Relay behavior:**
- Retries on 5xx (up to 2 retries, 1s delay)
- Truncates responses to 500KB
- Uses `messageId` from the original `new_message` so the backend can route to the correct conversation
- Timeout: 15s per attempt

---

### 2.3 Council — `POST /council` (Optional)

**Purpose:** Query multiple LLMs in parallel. Used by power users / programmatic integrations.

**Request:**
- `Authorization: Bearer <ak_...api_key>`
- `Content-Type: application/json`
- Body: `{ "prompt": string, "models"?: string[] }`

**Limits:**
- Prompt max 100KB
- Max 8 models per request
- 10 requests per minute (relay expects 429 on rate limit)

**Expected response:**
```json
{
  "success": boolean,
  "responses": [
    { "modelId": string, "response": string, "error"?: string }
  ]
}
```

**Error handling:**
- `401` / `403` → auth failed
- `429` → rate limit
- `402` → requires subscription

---

## 3. Message Schemas (TypeScript)

### IncomingMessage (SSE `new_message` event)

```typescript
interface IncomingMessage {
  messageId: string;   // Required — used when responding
  content: string;     // Required — user's text
  images?: string[];   // Optional — base64-encoded
  userId: string;      // ArkiTek user ID
  timestamp: string;    // ISO 8601
}
```

**Limits enforced by relay:**
- Max 20 images per message
- Max 10MB per image string

### RespondPayload (POST /respond body)

```typescript
interface RespondPayload {
  messageId: string;
  content: string;
}
```

### RespondResponse (POST /respond response)

```typescript
interface RespondResponse {
  success: boolean;
  delivered: boolean;
}
```

---

## 4. API Key Format

- **Pattern:** `ak_` + 64 alphanumeric chars (`ak_[a-zA-Z0-9]{64}`)
- **Length:** 67 characters
- **Usage:** Bearer token on all relay API calls

---

## 5. Config & Agent Lifecycle (User Device Side)

### Persisted config (`~/.arkitek-relay/config.json`)

```typescript
interface PersistedConfig {
  version: number;
  arkitekApiKey: string;
  arkitekRelayUrl?: string;   // Override base URL
  gatewayUrl?: string;        // OpenClaw gateway
  agentId?: string;            // OpenClaw agent ID, default "main"
  installedAt: string;
  lastUpdated: string;
}
```

- Gateway token is **never** persisted — always from env or OpenClaw config
- Config resolution order: CLI flags → env vars → persisted config → OpenClaw detection → defaults

### OpenClaw integration

- Gateway URL default: `http://localhost:18789`
- Relay expects OpenClaw `/v1/responses` endpoint enabled
- Relay POSTs to `/v1/responses` with: `{ model: "openclaw", input: message.content }`
- Expects response shape: `{ output: [{ type: "message", content: [{ type: "output_text", text: string }] }] }`
- Headers: `x-openclaw-agent-id`, optional `Authorization: Bearer <gateway_token>`

### SKILL.md for OpenClaw

- Installed to `~/.openclaw/skills/arkitek-relay/SKILL.md`
- Metadata includes: `requires.env: ["ARKITEK_API_KEY"]`, `requires.bins: ["node","npx"]`, `install` directive for `arkitek-relay-skill` npm package

---

## 6. System Service (Auto-Start)

| Platform | Type        | Location                                                |
|----------|-------------|---------------------------------------------------------|
| macOS    | LaunchAgent | `~/Library/LaunchAgents/com.arkitekai.relay.plist`     |
| Linux    | systemd     | `~/.config/systemd/user/arkitek-relay.service`          |
| Windows  | Task        | `ArkiTekRelay` (runs at logon)                         |

User-scoped — no admin. Relay offers to install during `--install` wizard.

---

## 7. CLI Commands (Relay Package)

| Command        | Description                                         |
|----------------|-----------------------------------------------------|
| (default)      | Start relay; first run triggers guided setup       |
| `--install`    | 9-step guided setup wizard                         |
| `--init-skill` | Place SKILL.md into OpenClaw skills dir            |
| `--doctor`     | Run diagnostic checks (config, gateway, service…)  |
| `--status`     | Show saved configuration                           |
| `--logs`       | View relay log output                              |
| `--uninstall`  | Remove service + `~/.arkitek-relay` config         |
| `--help`       | Help                                                |

---

## 8. Doctor Command — Detailed Diagnostics (`--doctor`)

The `--doctor` command runs 10 sequential checks and reports pass/warn/fail for each. It's the primary troubleshooting tool and the first thing a user should run when something isn't working. Run with: `npx arkitek-relay-skill --doctor`

### What it checks

| # | Check | Pass (✓) | Fail / Warn | Fix |
|---|-------|----------|-------------|-----|
| 1 | **Node.js version** | `Node.js 22.1.0` | `Node.js 18.x — version 20.3+ required` | Install Node 20+ from nodejs.org |
| 2 | **Persisted config** | `Config found at ~/.arkitek-relay/config.json` (shows install/update dates) | `No saved config found` | Run `--install` |
| 3 | **API key** | `ArkiTek API key: ak_****...ab1c` (masked) | `No ArkiTek API key found` | Set `ARKITEK_API_KEY`, use `--api-key`, or run `--install` |
| 4 | **OpenClaw config** | `OpenClaw config: ~/.openclaw/openclaw.json` (shows gateway URL, token presence, /v1/responses status) | `OpenClaw config not found` or `/v1/responses disabled` | Install OpenClaw or enable endpoint |
| 5 | **Gateway reachability** | `Gateway reachable at http://localhost:18789` | `Gateway not reachable` | Start OpenClaw: `openclaw gateway start` |
| 6 | **/v1/responses live check** | `/v1/responses endpoint is responding` (only runs if gateway reachable) | `returned 405 (disabled)` or `status unknown` | `openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true` |
| 7 | **ArkiTek cloud** | `ArkiTek cloud reachable (arkitekai.com)` | `Cannot reach arkitekai.com` | Check internet/firewall (outbound HTTPS port 443) |
| 8 | **System service** | `System service: running (darwin)` | `installed but not running` or `not installed (optional)` | Run `--install` to set up service |
| 9 | **SKILL.md placement** | `Skill definition installed: ~/.openclaw/skills/arkitek-relay/SKILL.md` | `SKILL.md not found in OpenClaw skills directory` | Run `--init-skill` |
| 10 | **Log file sizes** | (silent if OK) | `Output log is 150MB — consider truncating` | Truncate: `: > ~/.arkitek-relay/relay.log` |

### Summary output

- **All pass:** `✓ All checks passed. Your relay should work correctly.`
- **Issues found:** `⚠ 3 issues found. Fix the items above and run --doctor again.`

### Why this matters for app agents

- **UI troubleshooting:** When an agent is offline in the ArkiTek UI, suggest "Run `npx arkitek-relay-skill --doctor`" — it covers every common failure point.
- **Support flow:** Doctor output is a complete diagnostic snapshot. Consider building a "paste your doctor output" feature for support requests.
- **Status correlation:** Check 7 (ArkiTek cloud reachable) confirms the user can reach your servers. If the relay connects but the user reports issues, the problem is likely on the backend side. If Check 7 fails, it's a network/firewall issue on the user's end.
- **Error states:** Checks 5-6 (gateway reachable + /v1/responses) determine whether the relay runs in "gateway mode" (forwarding to OpenClaw) or "echo mode" (just echoing messages back). The UI should surface this distinction if the agent responds with echo-style messages.

---

## 9. v1.0.9 Changes Summary (What Was Pushed)

### New

- Full CLI suite with interactive 9-step install wizard
- Config persistence at `~/.arkitek-relay/config.json`
- OpenClaw auto-detection and `/v1/responses` endpoint check
- SKILL.md auto-placement during setup
- System service management (macOS/Linux/Windows)
- Doctor command (Node, config, API key, gateway, ArkiTek reachability, service, SKILL placement, log sizes)
- Log rotation (50MB max, 1 backup) and `--logs` command
- Postinstall script with setup instructions

### Changed

- Codebase modularized into `cli/`, `config/`, `service/`
- `--install` now drives the full setup flow instead of minimal config
- First run auto-detects first run and prompts for setup

### Fixed (from 1.0.8)

- `activeHandlers` leak when handler returns non-Promise
- Dropped messages (concurrency limit) now send error response to server
- `.env` poisoning warning for `ARKITEK_API_KEY`

---

## 10. Recommendations for App Backend & UI

### Backend

1. **SSE `/stream`**  
   - Emit `connected` with `agentId` as soon as auth succeeds.  
   - Emit `ping` with `{ "t": <unix_ms> }` at least every 30–45s to stay ahead of the relay’s 60s timeout.  
   - Emit `new_message` with exact `IncomingMessage` shape; `messageId` and `content` are required.

2. **POST `/respond`**  
   - Accept `{ messageId, content }`, validate `messageId` matches an in-flight message.  
   - Return `{ success: true, delivered: true }` when the response is delivered to the UI.  
   - Support 5xx retries (relay retries up to 2 times).

3. **API key UX**  
   - Keys must match `ak_[a-zA-Z0-9]{64}`.  
   - On revoke, ensure 401/403 on next stream/respond so the relay stops retrying.

4. **Agent creation flow**  
   - When creating an agent, show the `ak_...` key and instructions: `npm install -g arkitek-relay-skill` then `npx arkitek-relay-skill`.  
   - Document `arkitekai.com` → Agents → Add Agent → Create → copy key.

5. **Council API**  
   - Return 402 when subscription required; 429 when rate limited.

### UI

1. **Agent status**  
   - “Online” when the relay has received `connected` and is sending heartbeats.  
   - “Offline” when stream is closed or no recent activity.

2. **Error messages**  
   - When relay sends `[Error] ...` responses (e.g. gateway down, 405), surface these in the chat so users know the agent had a problem.

3. **First-time setup**  
   - In the “Add Agent” flow, link to or embed the same steps as SKILL.md/README: install package, run command, paste API key.

4. **Uninstall / disconnect**  
   - Document that `--uninstall` removes local config and service but not the SKILL.md (user deletes that manually if desired).

### Consistency

- Use the same base URL (`https://api.arkitekai.com/api/v1/agents/relay`) in docs and SDKs.
- Use the same API key format and validation.
- Use the same message schema (`IncomingMessage`, `RespondPayload`) in backend and relay code.
- Align terminology: “agent” = ArkiTek agent linked to a relay; “relay” = this npm package; “OpenClaw” = user’s local agent framework.

---

## 11. Repo & Package Info

- **GitHub:** `https://github.com/raleighgardner16-source/arkitek-relay-skill`
- **npm:** `arkitek-relay-skill`
- **Version:** 1.0.9
- **Node:** >= 20.3.0

---

## 12. Quick Reference: Env Vars the Relay Understands

| Variable                | Purpose                         |
|-------------------------|---------------------------------|
| `ARKITEK_API_KEY`       | Required. Agent API key.        |
| `ARKITEK_RELAY_URL`     | Override relay base URL.        |
| `ARKITEK_AUTO_RECONNECT`| `false` to disable reconnect.  |
| `OPENCLAW_GATEWAY_URL`  | Override gateway URL.           |
| `OPENCLAW_GATEWAY_TOKEN`| Override gateway token.         |
| `OPENCLAW_AGENT_ID`     | Override agent ID (default `main`). |

---

## 13. End-to-End Setup: Terminal Steps (User's Device)

These are the steps the user follows in their terminal (or however they already interact with their agent, e.g. OpenClaw CLI). The relay's `--install` wizard drives most of this; below is what each step does.

### Before Running the Relay

| Step | What the user does | Notes |
|------|--------------------|-------|
| 0a | Ensure Node.js 20.3+ is installed | `node -v` |
| 0b | Start their OpenClaw agent / gateway | e.g. `openclaw gateway start` |
| 0c | (Optional) Enable `/v1/responses` if not already | `openclaw gateway config.patch --set gateway.http.endpoints.responses.enabled=true` |

### Relay Install Wizard (9 steps)

When the user runs `npx arkitek-relay-skill` or `npx arkitek-relay-skill --install`:

| Step | Terminal / relay step | What happens |
|------|------------------------|--------------|
| 1 | **Prerequisites** | Relay checks Node.js version (20.3+ required) |
| 2 | **Detect OpenClaw** | Relay looks for `~/.openclaw/openclaw.json`, reads gateway URL and token |
| 3 | **Skill definition (SKILL.md)** | Relay asks to place SKILL.md in `~/.openclaw/skills/arkitek-relay/` so OpenClaw can discover the skill |
| 4 | **ArkiTek API Key** | User must paste API key. Prompt says: "Get your API key from https://arkitekai.com — Go to Agents → Add Agent → Create, then copy the ak_... key" |
| 5 | **Test gateway** | Relay pings gateway URL; warns if unreachable (relay will run in echo mode) |
| 6 | **Check /v1/responses** | Relay verifies endpoint; may offer to enable it via OpenClaw config patch |
| 7 | **Test ArkiTek cloud** | Relay pings arkitekai.com to confirm outbound reachability |
| 8 | **Save config** | Relay writes `~/.arkitek-relay/config.json` (API key, gateway URL, agent ID) |
| 9 | **System service** | Relay offers to install LaunchAgent/systemd/Task so relay auto-starts on boot |

### After Setup

- If service installed: relay runs in background. User can use `--doctor`, `--status`, `--logs`, `--uninstall`.
- If not: user runs `npx arkitek-relay-skill` manually to start the relay.

---

## 14. End-to-End Setup: UI Steps (ArkiTek Web App)

These are the steps the user should follow in the ArkiTek web UI so the agent and configuration align with the relay. The UI should guide users through this flow when adding a self-hosted/OpenClaw agent.

### Recommended UI Flow for "Add Agent" (Self-Hosted / OpenClaw)

| Step | UI action | What to show / do |
|------|-----------|-------------------|
| 1 | User clicks **Add Agent** or **Connect Agent** | Offer "Connect your OpenClaw agent" (or similar) as an option |
| 2 | Show **prerequisites** | Copy: "Node.js 20+, OpenClaw running, relay package. Install with: `npm install -g arkitek-relay-skill`" |
| 3 | **Create agent + generate API key** | Create the agent record in your backend and generate an `ak_...` key. Show the key prominently with a copy button. |
| 4 | **Show terminal command** | Display: `npx arkitek-relay-skill` and explain: "Run this in your terminal. On first run it will prompt for your API key — paste the key above." |
| 5 | **Link key and agent** | Ensure the API key is tied to this agent in your backend (agent ID, key binding). When the relay connects with this key, your SSE stream should associate it with this agent. |
| 6 | **Status indicator** | Once the relay connects (stream opens, `connected` event sent), show the agent as "Online". Show "Offline" when the stream is closed or no recent activity. |
| 7 | **Optional: connection tips** | If agent stays offline: "Run `npx arkitek-relay-skill --doctor` to diagnose. Ensure OpenClaw is running and `/v1/responses` is enabled." |

### UI Copy Suggestions

- **Before user has key:** "Create your agent below. You'll get an API key to paste into the relay when you run `npx arkitek-relay-skill`."
- **After agent created:** "Copy your API key and run `npx arkitek-relay-skill` in your terminal. Paste the key when prompted."
- **Agent offline:** "Your agent isn't connected. Make sure the relay is running (`npx arkitek-relay-skill`) and OpenClaw is started."
- **Agent online:** "Your agent is connected and ready to receive messages."

### Order of Operations (User Journey)

1. User opens ArkiTek UI → goes to Agents → Add Agent.
2. User creates the agent in the UI → gets API key (and optionally the `npx` command).
3. User opens terminal on their agent machine → runs `npx arkitek-relay-skill` (or `--install`).
4. Relay wizard runs → at Step 4, user pastes the API key from the UI.
5. Relay connects to ArkiTek → backend emits `connected` → UI shows agent as Online.
6. User can now chat with their agent from the ArkiTek UI.

---

*End of handoff document. Use this as context when implementing backend relay endpoints, agent onboarding, and UI flows in the ArkiTek app.*
