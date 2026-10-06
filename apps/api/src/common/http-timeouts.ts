import type { Server } from 'node:http';

export interface HttpTimeouts {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  checkIntervalMs: number;
}

/**
 * Server-wide slowloris defence (FU-BE-98). Node closes a connection that has not delivered its
 * headers within `headersTimeout` or its whole request (headers and body) within `requestTimeout`,
 * answering 408 where it still can, so every global body parser is covered. Idle keep-alive
 * sockets are dropped after `keepAliveTimeout`. The API has no WebSocket or SSE endpoint today;
 * Node clears these two timers once a request is complete or upgraded, so a later Socket.IO
 * gateway is not cut by them. Node only inspects connections every `connectionsCheckingInterval`
 * (30 s by default), so the real limit is the timeout plus up to one interval: keep it short.
 */
export function applyHttpTimeouts(server: Server, t: HttpTimeouts): void {
  server.headersTimeout = t.headersTimeoutMs;
  server.requestTimeout = t.requestTimeoutMs;
  server.keepAliveTimeout = t.keepAliveTimeoutMs;
  // Typed only on the constructor options; Node reads the instance property when it starts to listen.
  (server as Server & { connectionsCheckingInterval: number }).connectionsCheckingInterval =
    t.checkIntervalMs;
}
