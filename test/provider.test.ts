import assert from "node:assert/strict";
import { test } from "node:test";
import { providerRequest } from "../src/index.ts";

test("matches provider POSTs with URL path boundaries, including Request inputs", () => {
  const bases = ["", "not-a-url", "https://api.example.com/v1/"];
  assert.equal(providerRequest("https://api.example.com/v1/chat/completions", { method: "POST" }, bases), true);
  assert.equal(providerRequest(new Request("https://api.example.com/v1/responses", { method: "POST" }), undefined, bases), true);
  assert.equal(providerRequest(new URL("https://api.example.com/v1"), { method: "post" }, bases), true);
  assert.equal(providerRequest("https://api.example.com/v10/chat/completions", { method: "POST" }, bases), false);
  assert.equal(providerRequest("https://api.example.com.evil.test/v1", { method: "POST" }, bases), false);
  assert.equal(providerRequest("https://api.example.com/v1/models", undefined, bases), false);
  assert.equal(providerRequest("https://tools.example.com/v1/search", { method: "POST" }, bases), false);
  assert.equal(providerRequest(new Request("https://api.example.com/v1", { method: "POST" }), { method: "GET" }, bases), false);
});
