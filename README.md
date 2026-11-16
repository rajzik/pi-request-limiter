# pi-request-limiter

A Pi extension that queues provider HTTP requests when either rolling limit is full. The defaults are 24 requests in any minute and 1,000 requests in any hour.

Requests can burst until a limit is full. Each HTTP attempt consumes one slot, including failed attempts and retries. The next request waits until both windows have room. Pi shows the number of waiting requests in its status line. Cancelling a request also cancels its quota wait.

## Install

Requires the Node.js edition of Pi 1.5.2 or later and Node.js 22.19 or later. No runtime dependencies or build step are needed.

Install from GitHub:

```sh
pi install git:github.com/rajzik/pi-request-limiter
```

Restart Pi after installation.

To install a local checkout, run from its directory:

```sh
pi install "$PWD"
```

Keep a locally installed checkout at its installed path.

To try the extension for one run instead, use:

```sh
pi -e ./src/index.ts
```

For providers that support WebSockets, set `"transport": "sse"` in your existing `~/.pi/agent/settings.json`. The limiter controls HTTP calls made through `globalThis.fetch`; it cannot count WebSocket messages or providers that use a separate HTTP client.

## Change the limits

The defaults work without a config file. To change them, create `~/.pi/agent/rate-limit.json`:

```json
{
  "requestsPerMinute": 24,
  "requestsPerHour": 1000
}
```

Both values must be positive integers. Omitted values use the defaults. Restart all Pi processes after changing the limits.

All matched providers share one quota. Matching uses POST requests to the provider base URLs in Pi's model registry. Other HTTP traffic passes through.

The extension saves timestamps in `~/.pi/agent/rate-limit.sqlite`. Processes that use the same agent directory share this file and reserve slots in an atomic transaction. Restarting Pi does not reset the quota. `PI_CODING_AGENT_DIR` changes the directory for both files. Use the same limits in all processes that share the directory.

Invalid configuration or storage errors block matched provider requests. The extension restores the previous fetch function and closes its database on session shutdown or reload.

Requests from other applications or machines do not count toward this local quota. Provider-side token limits and `Retry-After` handling remain separate.

## Verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Tests cover rolling windows, hourly exhaustion, restart persistence, cancellation, and concurrent processes. An integration test runs Pi against a local HTTP provider and verifies a delayed internal retry, a real file-read tool call, and the following model request. It uses no external API or credentials and removes its temporary files and server.

Pi reference: [extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
