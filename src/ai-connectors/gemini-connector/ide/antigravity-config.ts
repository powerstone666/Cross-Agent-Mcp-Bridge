// Constants for the Antigravity hub route: service path, headers, polling and timeout.
export const HUB_HOST = "127.0.0.1";
export const HUB_SERVICE_PATH = "/exa.language_server_pb.LanguageServerService/";
export const HUB_HEALTH_PATH = "/healthz";
export const CSRF_HEADER = "x-codeium-csrf-token";
export const HOST_CLIENT_HEADER = "x-host-client";
export const HOST_CLIENT_VALUE = "relay/1";

export const POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 600_000;

export const CASCADE_SOURCE = "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT";
export const TRAJECTORY_VERBOSITY = "CLIENT_TRAJECTORY_VERBOSITY_PROD_UI";

export const WAITING_FOR_APPROVAL_LINE = "[waiting for your approval in Antigravity]";
export const NO_HUB_MESSAGE = "No Antigravity window is running. Open Antigravity and try again.";
export const TIMEOUT_MESSAGE = "Antigravity did not finish in time";

export function readIdeTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const parsed = Number(environment.RELAY_GEMINI_IDE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
