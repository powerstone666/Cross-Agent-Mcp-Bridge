// Proves how "@agent message" is parsed. An "@echo" mid-sentence must not send anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMention } from "../../src/bridge/utils/parse-mention.js";

test("parses the agent name and message", () => {
  assert.deepEqual(parseMention({ inputText: "@echo fix the failing test" }), {
    agentName: "echo",
    messageText: "fix the failing test",
  });
});

test("lowercases the agent name and keeps multi-line messages", () => {
  assert.deepEqual(parseMention({ inputText: "  @Echo line one\nline two  " }), {
    agentName: "echo",
    messageText: "line one\nline two",
  });
});

test("returns null without a mention or without a message", () => {
  assert.equal(parseMention({ inputText: "hello echo" }), null);
  assert.equal(parseMention({ inputText: "@echo" }), null);
  assert.equal(parseMention({ inputText: "@echo   " }), null);
  assert.equal(parseMention({ inputText: "hey @echo fix it" }), null);
});
