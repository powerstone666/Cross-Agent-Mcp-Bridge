// Creates the request token: a short id the bridge writes on every log line of one turn.
// Never use the token as a secret or for authentication.

import { randomBytes } from "node:crypto";

const REQUEST_TOKEN_BYTES = 4;

// For example "r-1a2b3c4d". Four random bytes tell turns apart but are not a secret.
export function createRequestToken(): string {
  return `r-${randomBytes(REQUEST_TOKEN_BYTES).toString("hex")}`;
}
