import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatController } from "../core/controller";
import type { EventBus } from "../core/events";
import { COCKPIT_PROTOCOL_HEADER, COCKPIT_PROTOCOL_VERSION } from "../core/events";
import { COCKPIT_TOKEN_HEADER, verifyToken } from "./auth";

// ─── Server factory ─────────────────────────────────────────────────────────

export interface CockpitServerOptions {
  readonly eventBus: EventBus;
  readonly controller: ChatController;
  readonly token: string;
}

export function createCockpitApp(opts: CockpitServerOptions): Hono {
  const app = new Hono();

  // Token auth middleware — every request must carry the cockpit token.
  app.use("*", async (c, next) => {
    const provided = c.req.header(COCKPIT_TOKEN_HEADER);
    if (verifyToken(provided, opts.token)) {
      await next();
      return;
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  // GET /events — SSE stream of CockpitEvents.
  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      c.header(COCKPIT_PROTOCOL_HEADER, String(COCKPIT_PROTOCOL_VERSION));

      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      const unsubscribe = opts.eventBus.subscribe((event) => {
        if (!ac.signal.aborted) {
          void stream.writeSSE({ data: JSON.stringify(event) });
        }
      });

      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) {
          resolve();
          return;
        }
        ac.signal.addEventListener("abort", () => resolve());
      });

      unsubscribe();
    });
  });

  // POST /input — submit user input to the ChatController.
  app.post("/input", async (c) => {
    const body = (await c.req.json()) as {
      sessionId?: string;
      text?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.sessionId || !body.text) {
      return c.json({ error: "sessionId and text required" }, 400);
    }
    await opts.controller.submit({
      sessionId: body.sessionId,
      text: body.text,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
    return c.json({ ok: true });
  });

  // POST /commands/:slash — dispatch a slash command.
  app.post("/commands/:slash", async (c) => {
    const slash = c.req.param("slash");
    const body = (await c.req.json()) as {
      sessionId?: string;
      args?: readonly string[];
    };
    if (!body.sessionId) {
      return c.json({ error: "sessionId required" }, 400);
    }
    await opts.controller.slash({
      sessionId: body.sessionId,
      command: slash,
      args: body.args ?? [],
    });
    return c.json({ ok: true });
  });

  return app;
}
