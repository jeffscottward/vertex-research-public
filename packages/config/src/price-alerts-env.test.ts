import { describe, expect, it } from "vitest";

import { serverEnvSchema } from "./server.ts";

describe("VERTEX_PRICE_ALERTS_NTFY_*", () => {
  const origin = serverEnvSchema.shape.VERTEX_PRICE_ALERTS_NTFY_ORIGIN;
  const topic = serverEnvSchema.shape.VERTEX_PRICE_ALERTS_NTFY_TOPIC;
  const token = serverEnvSchema.shape.VERTEX_PRICE_ALERTS_NTFY_TOKEN;

  it("are optional; blank means absent", () => {
    for (const schema of [origin, topic, token]) {
      expect(schema.safeParse(undefined)).toMatchObject({
        data: undefined,
        success: true,
      });
      expect(schema.safeParse(" ")).toMatchObject({
        data: undefined,
        success: true,
      });
    }
  });

  it("accepts only a bare https origin", () => {
    expect(origin.safeParse("https://ntfy.domain.test").success).toBe(true);
    for (const bad of [
      "http://ntfy.domain.test",
      "https://ntfy.domain.test/",
      "https://ntfy.domain.test/topic",
      "https://user:pass@ntfy.domain.test",
      "not a url",
    ]) {
      expect(origin.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts ntfy topic and token characters only", () => {
    expect(topic.safeParse("vertex_alerts-1").success).toBe(true);
    expect(topic.safeParse("has space").success).toBe(false);
    expect(topic.safeParse("x".repeat(129)).success).toBe(false);
    expect(token.safeParse("tk_abc.DEF~1-2").success).toBe(true);
    expect(token.safeParse("bad token").success).toBe(false);
  });
});
