// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  BrokerRecoveryStatus,
  VertexGatewayBinding,
} from "@darkfactory/api/vertex";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import {
  VertexReadError,
  type VertexFailureKind,
} from "../../components/research/vertex-client.ts";
import type { ExperienceServices } from "./ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "./shared.tsx";
import { ConnectionsWorkspace } from "./utilities.tsx";

// Owner rule (2026-10-30): Connections lists the gateways this session may
// observe and reads the first one by default. Nobody types a gateway ID.

const paperGateway: VertexGatewayBinding = {
  gatewayId: "gateway-test",
  environment: "paper",
  accountAlias: "fictional-paper",
};
const otherGateway: VertexGatewayBinding = {
  gatewayId: "gateway-other",
  environment: "paper",
  accountAlias: "fictional-paper",
};
const status = (
  overrides: Partial<BrokerRecoveryStatus> = {}
): BrokerRecoveryStatus => ({
  schemaVersion: "1.0.0",
  statusId: "status-1",
  gatewayId: "gateway-test",
  environment: "paper",
  observedAt: "2026-09-22T12:00:00.123456789Z",
  infrastructure: "observed",
  brokerHandshake: "authenticated",
  recovery: "completed",
  trading: "disabled",
  reasonCodes: ["connectivity-observed"],
  lastHumanRequestId: "human-request-1",
  ...overrides,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

const mount = async (
  reads: Partial<ExperienceServices["reads"]>
): Promise<HTMLDivElement> => {
  const base = createUnavailableExperienceServices();
  const services: ExperienceServices = {
    ...base,
    reads: { ...base.reads, ...reads },
  };
  const container = document.createElement("div");
  document.body.append(container);
  host = container;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ResearchReadScopeProvider scope={createResearchReadScope()}>
        <ExperienceProvider services={services}>
          <ConnectionsWorkspace />
        </ExperienceProvider>
      </ResearchReadScopeProvider>
    );
    await Promise.resolve();
  });
  await settle();
  return container;
};

const buttons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll("button"));

describe("Connections lists gateways instead of a gateway ID form", () => {
  it("lists the gateways and reads the first one by default, with no text field", async () => {
    const gateway = vi.fn(() => Promise.resolve(status()));
    const container = await mount({
      gateways: () => Promise.resolve([paperGateway, otherGateway]),
      gateway,
    });
    expect(container.querySelector("input, textarea")).toBeNull();
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "gateway-test",
      "gateway-other",
    ]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(gateway).toHaveBeenCalledWith(
      { gatewayId: "gateway-test", environment: "paper" },
      expect.any(AbortSignal)
    );
    expect(container.textContent).toContain("gateway-test / paper");
    expect(container.textContent).toContain("Trading disabled");
  });

  it("reads another gateway when its row is chosen", async () => {
    const gateway = vi.fn((input: { gatewayId: string }) =>
      Promise.resolve(status({ gatewayId: input.gatewayId }))
    );
    const container = await mount({
      gateways: () => Promise.resolve([paperGateway, otherGateway]),
      gateway,
    });
    const read = buttons(container).find(
      (button) => button.textContent === "Read gateway-other status"
    );
    await act(async () => {
      read?.click();
      await Promise.resolve();
    });
    await settle();
    expect(gateway).toHaveBeenLastCalledWith(
      { gatewayId: "gateway-other", environment: "paper" },
      expect.any(AbortSignal)
    );
    expect(container.textContent).toContain("gateway-other / paper");
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows[1]?.getAttribute("aria-current")).toBe("true");
  });

  it("explains an empty list and reads no status", async () => {
    const gateway = vi.fn(() => Promise.resolve(status()));
    const container = await mount({
      gateways: () => Promise.resolve([]),
      gateway,
    });
    expect(container.textContent).toContain("No broker gateways to show");
    expect(container.textContent).toContain("without any typing");
    expect(gateway).not.toHaveBeenCalled();
    expect(container.querySelector("input, textarea, select")).toBeNull();
    expect(container.textContent).toContain("Verify host trust");
  });

  it("shows a list failure with a retry that reads the list again", async () => {
    const gateways = vi
      .fn<ExperienceServices["reads"]["gateways"]>()
      .mockRejectedValueOnce(new VertexReadError("unavailable"))
      .mockResolvedValueOnce([paperGateway]);
    const container = await mount({
      gateways,
      gateway: () => Promise.resolve(status()),
    });
    expect(container.textContent).toContain("Source unavailable");
    const retry = buttons(container).find((button) =>
      button.textContent?.includes("Retry")
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await settle();
    expect(gateways).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("gateway-test / paper");
  });

  it.each([
    status({ gatewayId: "gateway-other" }),
    status({ environment: "live" }),
    { ...status(), trading: "enabled" },
    { ...status(), reasonCodes: [] },
  ])("withholds a malformed or wrong-identity status", async (value) => {
    const container = await mount({
      gateways: () => Promise.resolve([paperGateway]),
      gateway: () => Promise.resolve(value as BrokerRecoveryStatus),
    });
    expect(container.textContent).toContain("Source verification failed");
    expect(container.textContent).not.toContain("status-1");
  });

  it.each([
    ["denied", "Access not granted"],
    ["unavailable", "Source unavailable"],
    ["not-found", "Record not found"],
  ] as const)(
    "presents the %s status failure without inventing observations",
    async (kind: VertexFailureKind, title) => {
      const container = await mount({
        gateways: () => Promise.resolve([paperGateway]),
        gateway: () => Promise.reject(new VertexReadError(kind)),
      });
      expect(container.textContent).toContain(title);
      expect(container.textContent).not.toContain("status-1");
      expect(container.textContent).toContain("login and 2FA yourself");
    }
  );

  it("offers only status reads: no restart, rescan, recovery or order controls", async () => {
    const container = await mount({
      gateways: () => Promise.resolve([paperGateway, otherGateway]),
      gateway: () => Promise.resolve(status()),
    });
    const labels = Array.from(
      container.querySelectorAll("main button, table button")
    ).map((button) => button.textContent);
    expect(labels).toEqual(["Showing status", "Read gateway-other status"]);
    expect(
      buttons(container).filter((button) =>
        /Read|Showing/.test(button.textContent ?? "")
      )
    ).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(
      /<button[^>]*>(?:<(?!\/button)[^>]*>)*[^<]*(Restart|Rescan|Request recovery|Submit order|Cancel order|Modify order)/i
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});
