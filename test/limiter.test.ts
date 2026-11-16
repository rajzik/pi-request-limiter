import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { defaults, parseLimits, RequestLimiter } from "../src/limiter.ts";

function database(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rate-limit-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "quota.sqlite");
}

test("permits 24 requests, delays the 25th, then releases only expired slots", (t) => {
  const limiter = new RequestLimiter(database(t), defaults);
  t.after(() => limiter.close());
  for (let i = 0; i < 24; i++) assert.equal(limiter.tryAcquire(100_000 + i), 0);
  assert.equal(limiter.tryAcquire(100_100), 59_900);
  assert.equal(limiter.tryAcquire(160_000), 0);
  assert.equal(limiter.tryAcquire(160_000), 1);
});

test("enforces the hourly cap independently and remembers quota after restart", (t) => {
  const file = database(t);
  let limiter = new RequestLimiter(file, defaults);
  for (let i = 0; i < 1000; i++) assert.equal(limiter.tryAcquire(i * 3000), 0);
  limiter.close();
  limiter = new RequestLimiter(file, defaults);
  t.after(() => limiter.close());
  assert.equal(limiter.tryAcquire(3_000_000), 600_000);
  assert.equal(limiter.tryAcquire(3_600_000), 0);
  assert.equal(limiter.tryAcquire(3_600_000), 3000);
});

test("chooses the later window when both caps are full", (t) => {
  const limiter = new RequestLimiter(database(t), { requestsPerMinute: 2, requestsPerHour: 2 });
  t.after(() => limiter.close());
  assert.equal(limiter.tryAcquire(0), 0);
  assert.equal(limiter.tryAcquire(10), 0);
  assert.equal(limiter.tryAcquire(100), 3_599_900);
});

test("waits until a slot expires and cancels a pending request without reserving it", async (t) => {
  const limiter = new RequestLimiter(database(t), { requestsPerMinute: 1, requestsPerHour: 1000 });
  t.after(() => limiter.close());
  limiter.tryAcquire(Date.now() - 59_920);
  const start = Date.now();
  await limiter.acquire(new AbortController().signal);
  assert.ok(Date.now() - start >= 60);
  const cancel = new AbortController();
  const pending = limiter.acquire(cancel.signal);
  cancel.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(limiter.tryAcquire() > 59_000);
});

test("independent processes share one atomic burst allowance", async (t) => {
  const file = database(t);
  const module = new URL("../src/limiter.ts", import.meta.url).href;
  const code = `import {RequestLimiter, defaults} from ${JSON.stringify(module)};
    const limiter = new RequestLimiter(process.argv[1], defaults);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (limiter.tryAcquire(100000) === 0) allowed++;
    limiter.close(); process.stdout.write(String(allowed));`;
  const results = await Promise.all(Array.from({ length: 5 }, () => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => errors += chunk);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(Number(output)) : reject(new Error(errors)));
    t.after(() => { if (child.exitCode === null) child.kill(); });
  })));
  assert.equal(results.reduce((sum, value) => sum + value, 0), 24);
});

test("rejects invalid custom limits", () => {
  assert.deepEqual(parseLimits({}), defaults);
  assert.deepEqual(parseLimits({ requestsPerMinute: 10, requestsPerHour: 500 }), { requestsPerMinute: 10, requestsPerHour: 500 });
  for (const value of [null, [], 24, { requestsPerMinute: 0 }, { requestsPerHour: 1.5 }, { requestsPerMinute: "24" }]) {
    assert.throws(() => parseLimits(value));
  }
});
