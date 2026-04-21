import { SsrfBlockedError, makeHttpFetch } from "@/agent/tools/http";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeCtx } from "./helpers";

const HOST = "https://example.com";

const server = setupServer(
  http.get(`${HOST}/ok`, () =>
    HttpResponse.text("hello world", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  ),
  http.get(`${HOST}/big`, () =>
    HttpResponse.text("a".repeat(2048), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  ),
  http.get(`${HOST}/binary`, () =>
    HttpResponse.arrayBuffer(new Uint8Array([0, 1, 2, 3, 255]).buffer, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("http_fetch", () => {
  it("returns text body for text/* content-type", async () => {
    const tool = makeHttpFetch();
    const ctx = makeCtx();
    await tool.gate?.({ url: "https://example.com/ok" }, ctx);
    const out = await tool.execute({ url: "https://example.com/ok" }, ctx);
    expect(out.status).toBe(200);
    expect(out.bodyText).toBe("hello world");
    expect(out.bodyIsBase64).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it("truncates bodies past maxBytes", async () => {
    const tool = makeHttpFetch();
    const ctx = makeCtx();
    await tool.gate?.({ url: "https://example.com/big" }, ctx);
    const out = await tool.execute({ url: "https://example.com/big", maxBytes: 64 }, ctx);
    expect(out.truncated).toBe(true);
    expect(out.bodyText.length).toBe(64);
  });

  it("base64-encodes binary content-types", async () => {
    const tool = makeHttpFetch();
    const ctx = makeCtx();
    await tool.gate?.({ url: "https://example.com/binary" }, ctx);
    const out = await tool.execute({ url: "https://example.com/binary" }, ctx);
    expect(out.bodyIsBase64).toBe(true);
    expect(Buffer.from(out.bodyText, "base64")).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it("rejects file:// scheme", async () => {
    const tool = makeHttpFetch();
    await expect(tool.gate?.({ url: "file:///etc/passwd" }, makeCtx())).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("rejects literal loopback / RFC1918 IP", async () => {
    const tool = makeHttpFetch();
    await expect(tool.gate?.({ url: "http://127.0.0.1/" }, makeCtx())).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(tool.gate?.({ url: "http://10.0.0.1/" }, makeCtx())).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(tool.gate?.({ url: "http://169.254.169.254/" }, makeCtx())).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("rejects localhost hostname", async () => {
    const tool = makeHttpFetch();
    await expect(tool.gate?.({ url: "http://localhost:8080/" }, makeCtx())).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("allows private hosts when ctx.metadata.allowPrivateHosts", async () => {
    const tool = makeHttpFetch();
    // Should not throw at gate — actual fetch will fail (no server), but gate is the SUT here.
    await expect(
      tool.gate?.(
        { url: "http://127.0.0.1:1/" },
        makeCtx({ metadata: { allowPrivateHosts: true } }),
      ),
    ).resolves.toBeUndefined();
  });
});
