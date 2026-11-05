import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const caddyfile = readFileSync(new URL("./Caddyfile", import.meta.url), "utf8");

const proxyBlock = (): string => {
  const start = caddyfile.indexOf("reverse_proxy 127.0.0.1:3450 {");
  if (start < 0) throw new Error("vertex-web reverse_proxy block not found");
  return caddyfile.slice(start, caddyfile.indexOf("\n    }", start));
};

describe("vertex-web-tailnet Caddyfile", () => {
  it("overwrites the client-address header that auth rate limits trust", () => {
    // Better Auth and the contact throttle key on cf-connecting-ip. No
    // Cloudflare sits in front of QuantVPS, so the proxy must replace any
    // client value with the real peer address.
    return expect(proxyBlock()).toMatch(
      /^\s*header_up CF-Connecting-IP \{remote_host\}$/mu
    );
  });

  it("still drops a client-supplied X-Forwarded-Host", () => {
    return expect(proxyBlock()).toMatch(/^\s*header_up -X-Forwarded-Host$/mu);
  });

  it("sends the same Content-Security-Policy as the app", () => {
    return expect(caddyfile).toContain(
      `Content-Security-Policy "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"`
    );
  });
});
