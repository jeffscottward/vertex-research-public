import { describe, expect, it } from "vitest";

import { serverEnvSchema } from "./server.ts";

describe("VERTEX_DEPLOY_STATUS_URL / VERTEX_DEPLOY_STATUS_TOKEN", () => {
  it("are optional; blank means absent", () => {
    const url = serverEnvSchema.shape.VERTEX_DEPLOY_STATUS_URL;
    const token = serverEnvSchema.shape.VERTEX_DEPLOY_STATUS_TOKEN;
    expect(url.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(url.safeParse("")).toMatchObject({ success: true, data: undefined });
    expect(token.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    return expect(token.safeParse("  ")).toMatchObject({
      success: true,
      data: undefined,
    });
  });

  it("accepts only https URLs without credentials, query or fragment", () => {
    const url = serverEnvSchema.shape.VERTEX_DEPLOY_STATUS_URL;
    expect(
      url.safeParse("https://status.domain.test/vertex-status/v1").success
    ).toBe(true);
    expect(
      url.safeParse("http://status.domain.test/vertex-status/v1").success
    ).toBe(false);
    expect(
      url.safeParse("https://user:pass@status.domain.test/v1").success
    ).toBe(false);
    expect(url.safeParse("https://status.domain.test/v1?token=x").success).toBe(
      false
    );
    return expect(url.safeParse("not a url").success).toBe(false);
  });

  return it("requires tokens of at least 32 printable characters", () => {
    const token = serverEnvSchema.shape.VERTEX_DEPLOY_STATUS_TOKEN;
    expect(token.safeParse("a".repeat(32)).success).toBe(true);
    expect(token.safeParse("a".repeat(31)).success).toBe(false);
    return expect(
      token.safeParse(`${"a".repeat(20)} ${"b".repeat(20)}`).success
    ).toBe(false);
  });
});

describe("VERTEX_HISTORY_URL", () =>
  it("is optional and accepts https or loopback http URLs without credentials, query or fragment", () => {
    const url = serverEnvSchema.shape.VERTEX_HISTORY_URL;
    expect(url.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(url.safeParse("")).toMatchObject({ success: true, data: undefined });
    expect(
      url.safeParse("https://quantvps.tailnet.test:8443/vertex-history/v1")
        .success
    ).toBe(true);
    expect(
      url.safeParse("http://quantvps.tailnet.test:8443/vertex-history/v1")
        .success
    ).toBe(false);
    expect(
      url.safeParse("http://127.0.0.1:8791/vertex-history/v1").success
    ).toBe(true);
    expect(
      url.safeParse("http://user:pass@127.0.0.1:8791/vertex-history/v1").success
    ).toBe(false);
    expect(
      url.safeParse("https://user:pass@quantvps.tailnet.test/vertex-history/v1")
        .success
    ).toBe(false);
    return expect(
      url.safeParse("https://quantvps.tailnet.test/vertex-history/v1?x=1")
        .success
    ).toBe(false);
  }));

describe("VERTEX_RESEARCH_LENSES_URL", () =>
  it("is optional and accepts only https URLs without credentials, query or fragment", () => {
    const url = serverEnvSchema.shape.VERTEX_RESEARCH_LENSES_URL;
    expect(url.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(url.safeParse("")).toMatchObject({ success: true, data: undefined });
    expect(
      url.safeParse(
        "https://quantvps.tailnet.test:8443/vertex-research-lenses/v1"
      ).success
    ).toBe(true);
    expect(
      url.safeParse(
        "http://quantvps.tailnet.test:8443/vertex-research-lenses/v1"
      ).success
    ).toBe(false);
    expect(
      url.safeParse(
        "https://user:pass@quantvps.tailnet.test/vertex-research-lenses/v1"
      ).success
    ).toBe(false);
    return expect(
      url.safeParse(
        "https://quantvps.tailnet.test/vertex-research-lenses/v1?x=1"
      ).success
    ).toBe(false);
  }));

describe("VERTEX_PORTFOLIO_URL", () =>
  it("is optional and accepts https or loopback http URLs without credentials, query or fragment", () => {
    const url = serverEnvSchema.shape.VERTEX_PORTFOLIO_URL;
    expect(url.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(url.safeParse("")).toMatchObject({ success: true, data: undefined });
    expect(
      url.safeParse("https://quantvps.tailnet.test:8443/vertex-portfolio/v1")
        .success
    ).toBe(true);
    expect(
      url.safeParse("http://quantvps.tailnet.test:8443/vertex-portfolio/v1")
        .success
    ).toBe(false);
    expect(
      url.safeParse("http://127.0.0.1:8792/vertex-portfolio/v1").success
    ).toBe(true);
    expect(
      url.safeParse("http://user:pass@127.0.0.1:8792/vertex-portfolio/v1")
        .success
    ).toBe(false);
    expect(
      url.safeParse(
        "https://user:pass@quantvps.tailnet.test/vertex-portfolio/v1"
      ).success
    ).toBe(false);
    return expect(
      url.safeParse("https://quantvps.tailnet.test/vertex-portfolio/v1#x")
        .success
    ).toBe(false);
  }));

describe("OPENROUTER_API_KEY / VERTEX_ASSISTANT_MODEL", () => {
  it("keeps the key optional and printable", () => {
    const key = serverEnvSchema.shape.OPENROUTER_API_KEY;
    expect(key.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(key.safeParse(" ")).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(key.safeParse(`sk-or-v1-${"a".repeat(40)}`).success).toBe(true);
    expect(key.safeParse("short").success).toBe(false);
    return expect(
      key.safeParse(`${"a".repeat(20)} ${"b".repeat(20)}`).success
    ).toBe(false);
  });

  return it("defaults the model and accepts only OpenRouter model ids", () => {
    const model = serverEnvSchema.shape.VERTEX_ASSISTANT_MODEL;
    expect(model.parse(undefined)).toBe("anthropic/claude-sonnet-4.5");
    expect(model.parse("")).toBe("anthropic/claude-sonnet-4.5");
    expect(model.parse("openai/gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
    expect(model.safeParse("not a model").success).toBe(false);
    return expect(model.safeParse("https://evil.test/x").success).toBe(false);
  });
});

describe("IBKR_MONITOR_URL", () =>
  it("is optional and accepts only plain http loopback URLs without credentials, query or fragment", () => {
    const url = serverEnvSchema.shape.IBKR_MONITOR_URL;
    expect(url.safeParse(undefined)).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(url.safeParse("")).toMatchObject({ success: true, data: undefined });
    for (const ok of [
      "http://127.0.0.1:3461",
      "http://localhost:3461/",
      "http://[::1]:3461",
    ]) {
      expect(url.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      "not a url",
      "https://127.0.0.1:3461",
      "http://192.168.1.5:3461",
      "http://user:pass@127.0.0.1:3461",
      "http://127.0.0.1:3461/?x=1",
      "http://127.0.0.1:3461/#x",
    ]) {
      expect(url.safeParse(bad).success).toBe(false);
    }
  }));

describe("VERTEX_ORDERS_ENABLED and VERTEX_ORDER_BRIDGE_URL", () =>
  it("default to off and accept only a plain http loopback bridge URL", () => {
    const flag = serverEnvSchema.shape.VERTEX_ORDERS_ENABLED;
    expect(flag.parse(undefined)).toBe(false);
    expect(flag.parse("true")).toBe(true);
    const url = serverEnvSchema.shape.VERTEX_ORDER_BRIDGE_URL;
    expect(url.safeParse("").success).toBe(true);
    expect(url.safeParse("http://127.0.0.1:3470").success).toBe(true);
    expect(url.safeParse("https://127.0.0.1:3470").success).toBe(false);
    expect(url.safeParse("http://10.0.0.5:3470").success).toBe(false);
    const gate = serverEnvSchema.shape.VERTEX_ORDER_SUBMISSION;
    expect(gate.parse(undefined)).toBe("disabled");
    expect(gate.parse("enabled")).toBe("enabled");
    expect(gate.safeParse("on").success).toBe(false);
    const token = serverEnvSchema.shape.VERTEX_ORDER_BRIDGE_TOKEN;
    expect(token.safeParse("")).toMatchObject({
      success: true,
      data: undefined,
    });
    expect(token.safeParse("short").success).toBe(false);
  }));

describe("VERTEX_IBKR_RECOVERY_URL / VERTEX_IBKR_RECOVERY_TOKEN", () =>
  it("are optional, need https without secrets, and use their own token rules", () => {
    const url = serverEnvSchema.shape.VERTEX_IBKR_RECOVERY_URL;
    const token = serverEnvSchema.shape.VERTEX_IBKR_RECOVERY_TOKEN;
    expect(url.safeParse("")).toMatchObject({ data: undefined, success: true });
    expect(token.safeParse(" ")).toMatchObject({
      data: undefined,
      success: true,
    });
    expect(
      url.safeParse(
        "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1"
      ).success
    ).toBe(true);
    expect(
      url.safeParse("http://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1")
        .success
    ).toBe(false);
    expect(token.safeParse("r".repeat(48))).toMatchObject({
      data: "r".repeat(48),
      success: true,
    });
    expect(token.safeParse("short").error?.issues[0]?.message).toBe(
      "VERTEX_IBKR_RECOVERY_TOKEN must be at least 32 characters"
    );
    return expect(token.safeParse(`${"r".repeat(40)} x`).success).toBe(false);
  }));
