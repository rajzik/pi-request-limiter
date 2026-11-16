import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaults, parseLimits, RequestLimiter } from "./limiter.ts";

export function providerRequest(input: string | URL | Request, init: RequestInit | undefined, bases: string[]): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return false;
  const url = new URL(input instanceof Request ? input.url : input);
  return bases.some((base) => {
    const endpoint = URL.parse(base);
    if (!endpoint) return false;
    const path = endpoint.pathname.replace(/\/+$/, "");
    return url.origin === endpoint.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
  });
}

export default function rateLimit(pi: ExtensionAPI) {
  let cleanup = () => {};
  pi.on("session_shutdown", () => cleanup());
  pi.on("session_start", (_event, ctx) => {
    const dir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
    const config = join(dir, "rate-limit.json");
    let limiter: RequestLimiter | undefined;
    let failure: unknown;
    let limits = defaults;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        limits = parseLimits(JSON.parse(readFileSync(config, "utf8")));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      limiter = new RequestLimiter(join(dir, "rate-limit.sqlite"), limits);
    } catch (error) {
      failure = error;
      ctx.ui.notify(`Rate limiter cannot start: ${String(error)}. Provider HTTP requests are blocked.`, "error");
    }

    const shutdown = new AbortController();
    const original = globalThis.fetch;
    const waiting = new Set<symbol>();
    const updateStatus = () => ctx.ui.setStatus("request-limiter",
      `Limit: ${limits.requestsPerMinute}/min, ${limits.requestsPerHour}/hour${waiting.size ? `; waiting: ${waiting.size}` : ""}`);
    const wrapped: typeof fetch = async (input, init) => {
      if (shutdown.signal.aborted || !providerRequest(input, init, ctx.modelRegistry.getAll().map((model) => model.baseUrl))) {
        return original(input, init);
      }
      if (!limiter) throw failure;
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = requestSignal ? AbortSignal.any([shutdown.signal, requestSignal]) : shutdown.signal;
      const ticket = Symbol();
      try {
        await limiter.acquire(signal, () => { waiting.add(ticket); updateStatus(); });
      } finally {
        if (waiting.delete(ticket) && !shutdown.signal.aborted) updateStatus();
      }
      signal.throwIfAborted();
      return original(input, { ...init, signal });
    };
    globalThis.fetch = wrapped;
    updateStatus();

    cleanup = () => {
      shutdown.abort();
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
      limiter?.close();
      ctx.ui.setStatus("request-limiter", undefined);
      cleanup = () => {};
    };
  });
}
