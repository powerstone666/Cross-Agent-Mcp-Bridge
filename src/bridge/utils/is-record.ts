// Type guard for JSON from an agent. Never treat the data inside as safe: it checks shape only.

// True for a plain object (not an array or null). Agent messages are untrusted JSON, so
// check them before reading any field.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
