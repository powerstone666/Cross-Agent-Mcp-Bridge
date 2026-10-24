// Rejects browser-driven requests (cross-site forgery and DNS rebinding) to the local servers.
import { localhostAllowedHostnames, localhostAllowedOrigins, validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";

// Returns a reason to refuse the request, or undefined when it may proceed.
// Non-browser clients send no Origin and a localhost Host, so they pass.
export function rejectNonLocalRequest(headers: { host?: string | undefined; origin?: string | undefined }): string | undefined {
  const host = validateHostHeader(headers.host, localhostAllowedHostnames());
  if (!host.ok) return host.message;
  const origin = validateOriginHeader(headers.origin, localhostAllowedOrigins());
  return origin.ok ? undefined : origin.message;
}

// A cross-site page can send text/plain without a preflight, so writes must declare JSON.
export function isJsonContentType(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? "");
}
