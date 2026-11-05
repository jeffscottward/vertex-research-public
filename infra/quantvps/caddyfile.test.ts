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

  it("takes every host value from the server-side environment", () => {
    // The public tree names no host: Caddy reads the tailnet name and address from
    // /etc/vertex/hosts.env (container --env-file). An unset value falls back to a
    // reserved .invalid name, so the listener cannot bind to every interface.
    const config = caddyfile
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const host = "{$VERTEX_TAILNET_HOST:unset-vertex-tailnet-host.invalid}";
    const ipv4 = "{$VERTEX_TAILNET_IPV4:unset-vertex-tailnet-ipv4.invalid}";
    expect(config).toContain(`default_bind ${ipv4}\n`);
    expect(config).toContain(`\nhttps://${host}:3451 {\n  bind ${ipv4}\n`);
    expect(config).toContain(`not header Origin https://${host}:3451\n`);
    expect(caddyfile).not.toMatch(/\bts\.net\b|\b100\.\d+\.\d+\.\d+\b|fd7a:/u);
    return expect(
      config.match(/\{\$[A-Z0-9_]+(?::[^}]*)?\}/gu)?.sort()
    ).toEqual([host, host, ipv4, ipv4].sort());
  });
});
