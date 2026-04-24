import type { ChatInput, SlashCommandInput } from "@/cockpit/core/controller";
import { EventBus } from "@/cockpit/core/events";
import { COCKPIT_TOKEN_HEADER, generateCockpitToken } from "@/cockpit/web/auth";
import { createCockpitApp } from "@/cockpit/web/server";
import { describe, expect, it } from "vitest";

// ── Stub controller ─────────────────────────────────────────────────────────

function stubController() {
  const calls: Array<{ method: string; input: ChatInput | SlashCommandInput }> = [];
  return {
    calls,
    async submit(input: ChatInput): Promise<void> {
      calls.push({ method: "submit", input });
    },
    async slash(input: SlashCommandInput): Promise<void> {
      calls.push({ method: "slash", input });
    },
    async *events() {
      // no-op
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cockpit web server contract", () => {
  const token = generateCockpitToken();
  const bus = new EventBus();

  function makeApp() {
    const controller = stubController();
    const app = createCockpitApp({ eventBus: bus, controller, token });
    return { app, controller };
  }

  it("rejects requests without a token", async () => {
    const { app } = makeApp();
    const res = await app.request("/events");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects requests with wrong token", async () => {
    const { app } = makeApp();
    const res = await app.request("/events", {
      headers: { [COCKPIT_TOKEN_HEADER]: "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /input validates required fields", async () => {
    const { app } = makeApp();
    const res = await app.request("/input", {
      method: "POST",
      headers: {
        [COCKPIT_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }), // missing sessionId
    });
    expect(res.status).toBe(400);
  });

  it("POST /input dispatches to controller.submit", async () => {
    const { app, controller } = makeApp();
    const res = await app.request("/input", {
      method: "POST",
      headers: {
        [COCKPIT_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "s1", text: "hello strand" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0]?.method).toBe("submit");
    const input = controller.calls[0]?.input as ChatInput;
    expect(input.sessionId).toBe("s1");
    expect(input.text).toBe("hello strand");
  });

  it("POST /commands/:slash validates required fields", async () => {
    const { app } = makeApp();
    const res = await app.request("/commands/model", {
      method: "POST",
      headers: {
        [COCKPIT_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}), // missing sessionId
    });
    expect(res.status).toBe(400);
  });

  it("POST /commands/:slash dispatches to controller.slash", async () => {
    const { app, controller } = makeApp();
    const res = await app.request("/commands/spawn", {
      method: "POST",
      headers: {
        [COCKPIT_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "s1",
        args: ["claude", "review this PR"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0]?.method).toBe("slash");
    const input = controller.calls[0]?.input as SlashCommandInput;
    expect(input.command).toBe("spawn");
    expect(input.args).toEqual(["claude", "review this PR"]);
  });

  it("POST /commands/:slash defaults args to empty", async () => {
    const { app, controller } = makeApp();
    const res = await app.request("/commands/help", {
      method: "POST",
      headers: {
        [COCKPIT_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(200);
    const input = controller.calls[0]?.input as SlashCommandInput;
    expect(input.args).toEqual([]);
  });

  it("GET /events returns SSE stream with protocol header", async () => {
    const { app } = makeApp();

    const resPromise = app.request("/events", {
      headers: { [COCKPIT_TOKEN_HEADER]: token },
    });

    // Publish an event shortly after the connection opens.
    setTimeout(() => {
      bus.publish({
        t: "transcript.append",
        sessionId: "s1",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "hello from SSE",
        },
      });
    }, 50);

    const res = await resPromise;
    expect(res.status).toBe(200);

    // Read enough to see the first event in the stream.
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("hello from SSE")) break;
    }
    reader.cancel();

    expect(text).toContain("hello from SSE");
  });
});
