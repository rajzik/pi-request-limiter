import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("real Pi delays a provider retry and counts the request after a tool call", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rate-limit-e2e-"));
  const arrivals: number[] = [];
  const bodies: string[] = [];
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const extension = resolve("src/index.ts");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    arrivals.push(Date.now());
    bodies.push(body);
    if (arrivals.length === 1) {
      // Simulate two earlier calls whose minute window expires in three seconds.
      const db = new DatabaseSync(join(dir, "rate-limit.sqlite"));
      for (let i = 0; i < 2; i++) db.prepare("INSERT INTO requests (at) VALUES (?)").run(Date.now() - 57_000);
      db.close();
      response.writeHead(500, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "Please retry" } }));
      return;
    }
    const tool = arrivals.length === 2;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: "read-fixture", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: join(dir, "fixture.txt") }) } }] } : { content: "LIMITER_OK" }) });
    chunk({}, tool ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test",
      models: [{ id: "fixture", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 1 } },
    }));
    writeFileSync(join(dir, "fixture.txt"), "TOOL_RESULT_OK");
    writeFileSync(join(dir, "rate-limit.json"), JSON.stringify({ requestsPerMinute: 3, requestsPerHour: 5 }));
    child = spawn(process.execPath, [cli, "--print", "--no-session", "--no-extensions", "-e", extension,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read",
      "--provider", "fixture", "--model", "fixture", "Read the fixture, then finish."], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout?.on("data", (chunk) => output += chunk);
    child.stderr?.on("data", (chunk) => errors += chunk);
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child?.kill("SIGKILL"); reject(new Error(`Pi timed out: ${errors}`)); }, 15_000);
      child?.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child?.on("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(exit, 0, errors);
    assert.match(output, /LIMITER_OK/);
    assert.equal(arrivals.length, 3, errors);
    assert.ok(arrivals[1] - arrivals[0] >= 2900, `retry arrived after ${arrivals[1] - arrivals[0]}ms`);
    assert.match(bodies[2], /TOOL_RESULT_OK/);
    const db = new DatabaseSync(join(dir, "rate-limit.sqlite"));
    const row = db.prepare("SELECT count(*) AS count FROM requests").get();
    db.close();
    assert.equal(row?.count, 5);
    assert.equal(readFileSync(join(dir, "fixture.txt"), "utf8"), "TOOL_RESULT_OK");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child?.once("close", () => resolve()));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
