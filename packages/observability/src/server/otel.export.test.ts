// What: drives the real OTLP/HTTP exporters against a loopback collector (no exporter mocks).
// Used by: the unit project; otel.lifecycle.test.ts covers the same runtime with fake exporters.
// See: packages/observability/src/server/otel.ts#initializeTelemetry.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { initializeTelemetry } from "./otel.ts";

type CollectedRequest = Readonly<{
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}>;

type OtlpAttribute = Readonly<{
  key: string;
  value: Readonly<Record<string, unknown>>;
}>;

const attributeMap = (
  attributes: readonly OtlpAttribute[] | undefined
): Record<string, unknown> => {
  const entries: [string, unknown][] = [];
  for (const attribute of attributes ?? []) {
    entries.push([attribute.key, Object.values(attribute.value)[0]]);
  }
  return Object.fromEntries(entries);
};

const startCollector = async () => {
  const requests: CollectedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text = (
        request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw
      ).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(text) as unknown,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  // The package tsconfig lib predates ES2024, so Promise.withResolvers is not typed.
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const close = (): Promise<void> => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { close, endpoint: `http://127.0.0.1:${port}/otel/`, requests };
};

let closeCollector: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeCollector?.();
  closeCollector = undefined;
});

describe("OpenTelemetry real OTLP export", () => {
  return it("posts redacted spans and semantic metrics to a loopback collector", async () => {
    const collector = await startCollector();
    closeCollector = collector.close;
    const runtime = initializeTelemetry({
      enabled: true,
      serviceName: "darkfactory-worker",
      otlpEndpoint: collector.endpoint,
      otlpAllowedHosts: ["127.0.0.1"],
      allowInsecureOtlpLocalhost: true,
      otlpHeaders: { "X-Honeycomb-Team": "team-marker" },
    });
    expect(runtime.state).toEqual({ status: "exporting" });

    await runtime.withSpan(
      {
        name: "worker.export",
        correlation: { requestId: "request_export" },
        attributes: {
          enabled: true,
          nested: { category: "ignored" },
        } as unknown as Readonly<Record<string, string | number | boolean>>,
      },
      (span) => {
        span.addEvent({
          eventId: "event_export",
          name: "feature-item.created",
          occurredAt: "2026-07-23T12:00:00.000Z",
          correlation: { requestId: "request_export" },
        });
        return span.recordMetric({
          name: "darkfactory.semantic_event",
          value: 1,
          attributes: { eventName: "feature-item.created" },
        });
      }
    );
    await runtime.forceFlush();

    const traceRequests = collector.requests.filter(
      (request) => request.url === "/otel/v1/traces"
    );
    const metricRequests = collector.requests.filter(
      (request) => request.url === "/otel/v1/metrics"
    );
    expect(traceRequests).toHaveLength(1);
    expect(metricRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of collector.requests) {
      expect(request.method).toBe("POST");
      expect(request.headers["x-honeycomb-team"]).toBe("team-marker");
      expect(request.headers["content-type"]).toMatch(/^application\/json/);
    }

    const traceBody = traceRequests[0]?.body as {
      resourceSpans: ReadonlyArray<{
        resource: { attributes: readonly OtlpAttribute[] };
        scopeSpans: ReadonlyArray<{
          scope: { name: string };
          spans: ReadonlyArray<{
            name: string;
            attributes: readonly OtlpAttribute[];
            events: ReadonlyArray<{ attributes: readonly OtlpAttribute[] }>;
          }>;
        }>;
      }>;
    };
    const resourceSpans = traceBody.resourceSpans[0];
    expect(
      attributeMap(resourceSpans?.resource.attributes)["service.name"]
    ).toBe("darkfactory-worker");
    const scopeSpans = resourceSpans?.scopeSpans[0];
    expect(scopeSpans?.scope.name).toBe("@darkfactory/observability");
    const span = scopeSpans?.spans[0];
    expect(span?.name).toBe("worker.export");
    const spanAttributes = attributeMap(span?.attributes);
    expect(spanAttributes["enabled"]).toBe(true);
    expect(spanAttributes).not.toHaveProperty("nested");
    expect(span?.events).toHaveLength(1);
    expect(attributeMap(span?.events[0]?.attributes)).toEqual({
      "event.id": "event_export",
    });

    const metricBody = metricRequests.at(-1)?.body as {
      resourceMetrics: ReadonlyArray<{
        resource: { attributes: readonly OtlpAttribute[] };
        scopeMetrics: ReadonlyArray<{
          metrics: ReadonlyArray<{
            name: string;
            sum?: {
              dataPoints: ReadonlyArray<{
                asDouble?: number;
                asInt?: number | string;
                attributes: readonly OtlpAttribute[];
              }>;
            };
          }>;
        }>;
      }>;
    };
    const resourceMetrics = metricBody.resourceMetrics[0];
    expect(
      attributeMap(resourceMetrics?.resource.attributes)["service.name"]
    ).toBe("darkfactory-worker");
    const metric = resourceMetrics?.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((entry) => entry.name === "darkfactory.semantic_event");
    const point = metric?.sum?.dataPoints[0];
    expect(Number(point?.asDouble ?? point?.asInt)).toBe(1);
    expect(attributeMap(point?.attributes)["eventName"]).toBe(
      "feature-item.created"
    );

    return expect(runtime.dispose()).resolves.toBeUndefined();
  });
});
