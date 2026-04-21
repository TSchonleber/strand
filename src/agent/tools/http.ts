/**
 * http_fetch — Node fetch with SSRF guard + binary-aware body handling.
 *
 * SSRF posture: block file://, localhost, loopback, link-local, RFC1918 by
 * hostname AND by DNS-resolved IP. `ctx.metadata.allowPrivateHosts === true`
 * is the only escape hatch (for test fixtures / intranets).
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { AgentContext, Tool } from "../types";

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "strand/0.1 (+https://github.com/TSchonleber/strand)";

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/ld+json",
  "application/problem+json",
  "application/xhtml+xml",
];

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export interface HttpFetchArgs {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}

export interface HttpFetchResult {
  status: number;
  contentType: string;
  bodyText: string;
  truncated: boolean;
  bodyIsBase64: boolean;
}

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower === "::" || lower.startsWith("::ffff:")) {
      // Map IPv4-mapped to its v4 form.
      const mapped = lower.replace(/^::ffff:/, "");
      if (isIP(mapped) === 4) return ipIsPrivate(mapped);
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("fe80")) return true; // link-local
    return false;
  }
  return false;
}

function hostnameIsPrivate(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;
  return false;
}

async function ssrfCheck(u: URL, allowPrivate: boolean): Promise<void> {
  if (u.protocol === "file:") {
    throw new SsrfBlockedError("http_fetch: file:// scheme is not permitted");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`http_fetch: protocol "${u.protocol}" is not permitted`);
  }
  if (allowPrivate) return;
  const host = u.hostname;
  if (hostnameIsPrivate(host)) {
    throw new SsrfBlockedError(`http_fetch: hostname "${host}" is private/loopback`);
  }
  if (isIP(host) !== 0) {
    if (ipIsPrivate(host)) {
      throw new SsrfBlockedError(`http_fetch: literal IP "${host}" is private/loopback`);
    }
    return;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(
      `http_fetch: DNS lookup failed for "${host}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new SsrfBlockedError(
        `http_fetch: "${host}" resolved to private/loopback IP "${a.address}"`,
      );
    }
  }
}

function contentTypeIsText(ct: string): boolean {
  const c = ct.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!c) return false;
  for (const prefix of TEXT_CONTENT_TYPES) {
    if (c === prefix || c.startsWith(prefix)) return true;
  }
  return false;
}

export function makeHttpFetch(): Tool<HttpFetchArgs, HttpFetchResult> {
  return {
    name: "http_fetch",
    description:
      "HTTP(S) fetch with SSRF guard. Caps body at maxBytes. Non-text content returns base64.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
        maxBytes: { type: "integer", minimum: 1 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    sideEffects: "external",
    async gate(args: HttpFetchArgs, ctx: AgentContext) {
      let u: URL;
      try {
        u = new URL(args.url);
      } catch {
        throw new SsrfBlockedError(`http_fetch: invalid URL "${args.url}"`);
      }
      const allowPrivate = ctx.metadata?.["allowPrivateHosts"] === true;
      await ssrfCheck(u, allowPrivate);
    },
    async execute(args) {
      const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
      const headers: Record<string, string> = { "user-agent": DEFAULT_USER_AGENT };
      if (args.headers) {
        for (const [k, v] of Object.entries(args.headers)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const init: RequestInit = {
          method: args.method ?? "GET",
          headers,
          signal: controller.signal,
        };
        if (args.body !== undefined) init.body = args.body;
        const res = await fetch(args.url, init);
        const contentType = res.headers.get("content-type") ?? "";
        const buf = Buffer.from(await res.arrayBuffer());
        const truncated = buf.byteLength > maxBytes;
        const slice = truncated ? buf.subarray(0, maxBytes) : buf;
        const isText = contentTypeIsText(contentType);
        return {
          status: res.status,
          contentType,
          bodyText: isText ? slice.toString("utf8") : slice.toString("base64"),
          truncated,
          bodyIsBase64: !isText,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
