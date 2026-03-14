export interface ArkitekConfig {
  apiKey: string;
  autoReconnect?: boolean;
  baseUrl?: string;
}

export interface IncomingMessage {
  messageId: string;
  content: string;
  images?: string[];
  userId: string;
  timestamp: string;
}

export interface ConnectedEvent {
  agentId: string;
  timestamp: string;
}

export interface PingEvent {
  t: number;
}

export interface RespondPayload {
  messageId: string;
  content: string;
}

export interface RespondResponse {
  success: boolean;
  delivered: boolean;
}

export interface CouncilRequest {
  prompt: string;
  models?: string[];
}

export interface CouncilResponse {
  success: boolean;
  responses: CouncilModelResponse[];
}

export interface CouncilModelResponse {
  modelId: string;
  response: string;
  error?: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<string>;

export interface ArkitekRelayEvents {
  onConnect?: (agentId: string) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "auth_failed"
  | "reconnecting";

export const DEFAULT_BASE_URL = "https://api.arkitekai.com/api/v1/agents/relay";
export const API_KEY_PATTERN = /^ak_[a-zA-Z0-9]{64}$/;
export const MAX_RESPONSE_SIZE = 500 * 1024; // 500KB
export const MAX_COUNCIL_PROMPT_SIZE = 100 * 1024; // 100KB
export const MAX_COUNCIL_MODELS = 8;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 50;
export const RESPOND_TIMEOUT_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const COUNCIL_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_HANDLERS = 10;
export const RESPOND_MAX_RETRIES = 2;
export const RESPOND_RETRY_DELAY_MS = 1_000;
export const GRACEFUL_DRAIN_MS = 5_000;
export const GRACEFUL_DRAIN_POLL_MS = 100;
export const MAX_SSE_BUFFER_SIZE = 1_024 * 1_024; // 1MB
export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_IMAGE_SIZE = 10 * 1_024 * 1_024; // 10MB per image string
export const LOG_PREFIX = "[ArkiTek Relay]";
export const LOG_ROTATE_MAX_BYTES = 50 * 1_024 * 1_024; // 50MB
export const LOG_ROTATE_KEEP = 1; // number of rotated backups to keep

// ── Config Resolution ──────────────────────────────────────────────

export interface OpenClawDetectedConfig {
  configPath: string;
  gatewayUrl: string;
  gatewayToken?: string;
  responsesEnabled: boolean;
}

export interface PersistedConfig {
  version: number;
  arkitekApiKey: string;
  arkitekRelayUrl?: string;
  gatewayUrl?: string;
  agentId?: string;
  installedAt: string;
  lastUpdated: string;
}

export type ConfigSourceLabel = "cli" | "env" | "persisted" | "openclaw" | "default" | "prompt";

export interface ConfigSource {
  arkitekApiKey: ConfigSourceLabel;
  gatewayUrl: ConfigSourceLabel;
  gatewayToken?: ConfigSourceLabel;
}

export interface ResolvedConfig {
  arkitekApiKey: string;
  arkitekRelayUrl: string;
  autoReconnect: boolean;
  gatewayUrl: string;
  gatewayToken?: string;
  agentId: string;
  source: ConfigSource;
}

// ── CLI ────────────────────────────────────────────────────────────

export type CLICommand = "start" | "install" | "init-skill" | "doctor" | "status" | "logs" | "uninstall" | "help";

export interface CLIOptions {
  command: CLICommand;
  apiKey?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  agentId?: string;
  skillsDir?: string;
  yes?: boolean;
}

export const DEFAULT_GATEWAY_URL = "http://localhost:18789";
export const RELAY_CONFIG_DIR = ".arkitek-relay";
export const RELAY_CONFIG_FILE = "config.json";
export const PERSISTED_CONFIG_VERSION = 1;

// ── System Service ────────────────────────────────────────────────

export interface ServiceConfig {
  nodePath: string;
  scriptPath: string;
  logPath: string;
  errorLogPath: string;
}

export interface ServiceInfo {
  installed: boolean;
  running: boolean;
  platform: string;
  servicePath?: string;
}

export const SERVICE_LABEL = "com.arkitekai.relay";
