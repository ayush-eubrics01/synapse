import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Container } from "../container";

const KEEP_ALIVE_MS = 15_000;

export function streamRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/stream", (ctx) =>
    streamSSE(ctx, async (stream) => {
      let closed = false;
      let wake: () => void = () => {};
      const aborted = new Promise<void>((resolve) => {
        wake = resolve;
      });
      // Flush headers right away so EventSource sees `open` before the first event.
      await stream.write(": connected\n\n");
      const unsubscribe = c.live.subscribe((msg) => {
        if (closed) return;
        stream.writeSSE({ event: msg.type, data: JSON.stringify(msg.data) }).catch(() => {});
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake();
      });
      const timer = setInterval(() => {
        if (!closed) stream.write(": keep-alive\n\n").catch(() => {});
      }, KEEP_ALIVE_MS);
      try {
        await aborted;
      } finally {
        clearInterval(timer);
        unsubscribe();
      }
    }),
  );
  return app;
}
