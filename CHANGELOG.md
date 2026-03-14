# Changelog

## [1.0.11] - 2026-03-14

### Fixed
- Wizard now detects when a different API key in a `.env` file or environment variable would override the key the user just entered, and warns them with the exact file path to clean up
- After saving config, the wizard sets `process.env.ARKITEK_API_KEY` to the new key so the current session always uses it (previously, a stale `.env` key would silently win)

## [1.0.10] - 2026-03-14

### Fixed
- Auth failure (401/403) no longer crashes with a raw stack trace — shows a clear message with the source of the rejected key and instructions to fix it
- Fatal error handler suppresses stack trace for auth errors, only shows the actionable message

## [1.0.9] - 2026-03-14

### Added
- Full CLI suite: `--install`, `--doctor`, `--status`, `--logs`, `--uninstall`, `--init-skill`, `--help`
- Interactive guided setup wizard with 9-step install flow
- System service management (macOS LaunchAgent, Linux systemd, Windows Task Scheduler)
- Config persistence at `~/.arkitek-relay/config.json`
- OpenClaw auto-detection and `/v1/responses` endpoint validation
- SKILL.md auto-placement into OpenClaw skills directory
- Diagnostic doctor command with comprehensive health checks
- Log rotation and log viewing commands
- Postinstall script with setup instructions

### Changed
- Modularized codebase into `cli/`, `config/`, and `service/` directories

## [1.0.8] - 2026-03-14

### Fixed
- `activeHandlers` counter no longer leaks a slot if the message handler returns a non-Promise value
- Messages dropped due to concurrency limits now send an error response back to the server instead of silently disappearing
- CWD `.env` poisoning warning now covers `ARKITEK_API_KEY` in addition to gateway-related keys

### Changed
- Renamed internal `GATEWAY_SENSITIVE_KEYS` to `SENSITIVE_KEYS` to reflect broader coverage

## [1.0.7] - 2026-03-12

### Added
- Initial public release
- SSE relay client with auto-reconnect and exponential backoff
- OpenClaw gateway auto-detection and forwarding
- Council multi-model query API
- CLI with `--install`, `--doctor`, `--status`, `--logs`, `--uninstall`, `--init-skill`
- System service support for macOS (launchd), Linux (systemd), Windows (Task Scheduler)
- SKILL.md auto-placement for OpenClaw discovery
- TLS enforcement, API key validation, config file permission hardening
