import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

export type Limits = { requestsPerMinute: number; requestsPerHour: number };
export const defaults: Limits = { requestsPerMinute: 24, requestsPerHour: 1000 };

export function parseLimits(value: unknown): Limits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Rate limit config must be a JSON object.");
  }
  const minute = "requestsPerMinute" in value ? value.requestsPerMinute : defaults.requestsPerMinute;
  const hour = "requestsPerHour" in value ? value.requestsPerHour : defaults.requestsPerHour;
  if (typeof minute !== "number" || !Number.isSafeInteger(minute) || minute < 1 ||
      typeof hour !== "number" || !Number.isSafeInteger(hour) || hour < 1) {
    throw new Error("requestsPerMinute and requestsPerHour must be positive safe integers.");
  }
  return { requestsPerMinute: minute, requestsPerHour: hour };
}

export class RequestLimiter {
  private readonly db: DatabaseSync;
  private readonly limits: Limits;

  constructor(file: string, limits: Limits) {
    this.limits = parseLimits(limits);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS requests (at INTEGER NOT NULL)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // Returns zero after reserving a request, or milliseconds until a slot opens.
  tryAcquire(now = Date.now()): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM requests WHERE at <= ?").run(now - 3_600_000);
      const times = this.db.prepare("SELECT at FROM requests ORDER BY at").all().map((row) => {
        if (typeof row.at !== "number" || !Number.isSafeInteger(row.at)) {
          throw new Error("Invalid timestamp in rate limit database.");
        }
        return row.at;
      });
      let delay = 0;
      for (const [window, limit] of [
        [60_000, this.limits.requestsPerMinute],
        [3_600_000, this.limits.requestsPerHour],
      ]) {
        const recent = times.filter((at) => at > now - window);
        const expires = recent[recent.length - limit];
        if (expires !== undefined) delay = Math.max(delay, expires + window - now);
      }
      if (delay === 0) this.db.prepare("INSERT INTO requests (at) VALUES (?)").run(now);
      this.db.exec("COMMIT");
      return delay;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async acquire(signal: AbortSignal, onWait?: () => void): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const delay = this.tryAcquire();
      if (delay === 0) return;
      onWait?.();
      // Recheck at least once a second, including after a clock adjustment.
      await sleep(Math.min(delay, 1000), undefined, { signal });
    }
  }

  close(): void {
    this.db.close();
  }
}
