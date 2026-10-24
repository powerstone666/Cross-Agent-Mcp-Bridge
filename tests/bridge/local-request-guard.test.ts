import assert from "node:assert/strict";
import test from "node:test";
import { isJsonContentType, rejectNonLocalRequest } from "../../src/bridge/utils/local-request-guard.js";

test("accepts localhost clients with or without an Origin", () => {
  assert.equal(rejectNonLocalRequest({ host: "127.0.0.1:8000" }), undefined);
  assert.equal(rejectNonLocalRequest({ host: "localhost:38765", origin: "http://localhost:8000" }), undefined);
});

test("refuses foreign origins, rebinding hosts and the null origin", () => {
  assert.ok(rejectNonLocalRequest({ host: "127.0.0.1:8000", origin: "https://evil.example" }));
  assert.ok(rejectNonLocalRequest({ host: "evil.example" }));
  assert.ok(rejectNonLocalRequest({ host: "127.0.0.1:8000", origin: "null" }));
  assert.ok(rejectNonLocalRequest({}));
});

test("only application/json counts as a JSON content type", () => {
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType(undefined), false);
});
