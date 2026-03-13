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

export const DEFAULT_BASE_URL = "https://arkitekai.com/api/v1/agents/relay";
export const API_KEY_PATTERN = /^ak_[a-zA-Z0-9]{64}$/;
export const MAX_RESPONSE_SIZE = 500 * 1024; // 500KB
export const MAX_COUNCIL_PROMPT_SIZE = 100 * 1024; // 100KB
export const MAX_COUNCIL_MODELS = 8;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 50;
export const RESPOND_TIMEOUT_MS = 15_000;
export const COUNCIL_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_HANDLERS = 10;
export const RESPOND_MAX_RETRIES = 2;
export const RESPOND_RETRY_DELAY_MS = 1_000;
export const MAX_SSE_BUFFER_SIZE = 1_024 * 1_024; // 1MB
export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_IMAGE_SIZE = 10 * 1_024 * 1_024; // 10MB per image string
export const LOG_PREFIX = "[ArkiTek Relay]";
