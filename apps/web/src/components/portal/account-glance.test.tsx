// @vitest-environment jsdom
import type {
  IbkrRecoveryStatusOutput,
  PortfolioMonitorOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AccountGlance,
  GLANCE_REFRESH_SECONDS,
  GLANCE_STAT_KEYS,
} from "./account-glance.tsx";
import type { IbkrRecoveryGateway } from "./ibkr-recovery-client.ts";
import type { PortfolioMonitorGateway } from "./portfolio-monitor-client.ts";
import { fixtureSnapshot } from "./portfolio-monitor-fixture.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await flush();
  });
  return container;
};

const run = async (action: () => void) => {
  await act(async () => {
    action();
    await flush();
  });
};

type Answer =
  | PortfolioMonitorOutput
  | Error
  | Readonly<{ code: string; message: string }>;

// Answers in order; the last one repeats. Non-snapshot answers are thrown as errors.
const gatewayOf = (...answers: Answer[]) => {
  let call = 0;
  const snapshot = vi.fn(async (): Promise<PortfolioMonitorOutput> => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer === undefined || !("readOnly" in answer)) throw answer;
    return answer;
  });
  return { snapshot } satisfies PortfolioMonitorGateway;
};

const find = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
};

const buttonNamed = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label
  );
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const health = () => find("[data-health]").textContent ?? "";

describe("AccountGlance", () => {
  it("shows NLV, daily P&L and margin use from the ibkr-monitor snapshot and links to Portfolio", async () => {
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(<AccountGlance gateway={gateway} />);
    expect(gateway.snapshot).toHaveBeenCalledOnce();
    expect(find("[data-account-glance] h2").textContent).toBe("IBKR account");
    expect(health()).toContain("Live");
    expect(find("[data-freshness]").textContent).toMatch(
      /^Data as of \d{2}:\d{2}:\d{2} \(\d+ s ago\)$/u
    );
    expect(
      [...document.querySelectorAll("[data-stat]")].map((node) =>
        node.getAttribute("data-stat")
      )
    ).toEqual([...GLANCE_STAT_KEYS]);
    const nlv = find("[data-stat=netLiquidation]");
    expect(nlv.querySelector("dt")?.textContent).toBe("Net Liquidation");
    expect(nlv.textContent).toContain("$20,000");
    const daily = find("[data-stat=daily]");
    expect(daily.querySelector("dt")?.textContent).toBe("Daily P&L");
    expect(daily.textContent).toContain("+$200");
    expect(daily.textContent).toContain("1.01% of start NLV");
    const margin = find("[data-stat=maintMargin]");
    expect(margin.querySelector("dt")?.textContent).toBe("Maintenance Margin");
    expect(margin.textContent).toContain("12.5% of equity");
    const link = find("[data-account-glance] a");
    expect(link.textContent).toBe("Open Portfolio");
    expect(link.getAttribute("href")).toBe("/portfolio");
    expect(link.className).toContain("min-h-11");
    // Read-only: no button, no form. The 2FA control is absent without recovery props.
    expect(document.querySelector("[data-account-glance] button")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("shows the account mode next to the health badge", async () => {
    await mount(
      <AccountGlance
        gateway={gatewayOf(
          fixtureSnapshot({
            account: {
              mode: "live",
              modeSource: "confirmed",
              modeConfirmedAt: null,
              modeError: null,
              count: 1,
            },
          })
        )}
      />
    );
    const live = find("[data-account-mode]");
    expect(live.getAttribute("data-account-mode")).toBe("live");
    expect(live.textContent).toContain("Live account · read-only");
  });

  it("shows a paper account as paper", async () => {
    await mount(
      <AccountGlance
        gateway={gatewayOf(
          fixtureSnapshot({
            account: {
              mode: "paper",
              modeSource: "confirmed",
              modeConfirmedAt: null,
              modeError: null,
              count: 1,
            },
          })
        )}
      />
    );
    expect(find("[data-account-mode=paper]").textContent).toContain(
      "Paper account · read-only"
    );
  });

  it("names a mode mismatch with its fix and shows no stat values", async () => {
    await mount(
      <AccountGlance
        gateway={gatewayOf(
          fixtureSnapshot({
            account: {
              mode: null,
              modeSource: null,
              modeConfirmedAt: null,
              modeError: "mismatch",
              count: 0,
            },
            positions: [],
            orders: [],
          })
        )}
      />
    );
    expect(health()).toContain("Account data withheld");
    expect(find("[data-account-mode=mismatch]").textContent).toContain(
      "Account mode mismatch · data withheld"
    );
    expect(
      find("[data-banner=account-mode-mismatch]").getAttribute("role")
    ).toBe("alert");
    expect(document.querySelector("[data-stat]")).toBeNull();
    expect(document.querySelector("[data-banner=mode-mismatch]")).toBeNull();
  });

  it("omits a stat line the snapshot cannot compute", async () => {
    const snapshot = fixtureSnapshot();
    await mount(
      <AccountGlance
        gateway={gatewayOf({
          ...snapshot,
          summary: { ...snapshot.summary, equityWithLoanValue: null },
          pnl: { ...snapshot.pnl, daily: null },
        })}
      />
    );
    expect(find("[data-stat=maintMargin]").querySelectorAll("dd")).toHaveLength(
      1
    );
    expect(find("[data-stat=daily]").textContent).not.toContain("start NLV");
  });

  it(`polls every ${GLANCE_REFRESH_SECONDS} s`, async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(<AccountGlance gateway={gateway} />);
    await act(async () => {
      vi.advanceTimersByTime(GLANCE_REFRESH_SECONDS * 1000 - 1);
      await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
  });

  it("sends no request and names IBKR_MONITOR_URL when the reader is not configured", async () => {
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(<AccountGlance configured={false} gateway={gateway} />);
    expect(gateway.snapshot).not.toHaveBeenCalled();
    expect(health()).toContain("Not configured");
    const state = find("[data-monitor-state=not-configured]");
    expect(state.getAttribute("role")).toBe("status");
    expect(state.textContent).toContain("IBKR monitor not configured");
    expect(find("[data-failure-code]").textContent).toBe(
      "NOT_CONFIGURED: IBKR_MONITOR_URL is not set on this server"
    );
    expect(find("[data-freshness]").textContent).toBe("Data as of —");
    expect(document.querySelector("[data-stat]")).toBeNull();
    // The portfolio link stays available.
    expect(find("[data-account-glance] a").getAttribute("href")).toBe(
      "/portfolio"
    );
  });

  it("shows operator access required for a 403", async () => {
    await mount(
      <AccountGlance
        gateway={gatewayOf({ code: "FORBIDDEN", message: "Forbidden" })}
      />
    );
    expect(find("[data-monitor-state=forbidden]").textContent).toContain(
      "Operator access required"
    );
    expect(health()).toContain("Operator access required");
    expect(document.querySelector("[data-stat]")).toBeNull();
  });

  it("shows an unreachable reader and retries on request", async () => {
    const gateway = gatewayOf(
      { code: "UNAVAILABLE", message: "ibkr-monitor did not answer" },
      fixtureSnapshot()
    );
    await mount(<AccountGlance gateway={gateway} />);
    expect(health()).toContain("Server unreachable");
    const state = find("[data-monitor-state=unavailable]");
    expect(state.getAttribute("role")).toBe("alert");
    expect(find("[data-failure-code]").textContent).toBe(
      "UNAVAILABLE: ibkr-monitor did not answer"
    );
    await run(() => buttonNamed("Retry now").click());
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
    expect(health()).toContain("Live");
    expect(find("[data-stat=netLiquidation]").textContent).toContain("$20,000");
  });

  it("keeps the last values and says so when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await mount(
      <AccountGlance
        gateway={gatewayOf(fixtureSnapshot(), new Error("network down"))}
      />
    );
    await act(async () => {
      vi.advanceTimersByTime(GLANCE_REFRESH_SECONDS * 1000);
      await flush();
    });
    expect(find("[data-banner=failure]").textContent).toContain(
      "ERROR: network down"
    );
    expect(health()).toContain("Server unreachable");
    expect(find("[data-stat=netLiquidation]").textContent).toContain("$20,000");
  });

  it("warns when the gateway is disconnected", async () => {
    await mount(
      <AccountGlance
        gateway={gatewayOf(
          fixtureSnapshot({
            status: { gateway: "disconnected", connected: false },
          })
        )}
      />
    );
    expect(health()).toContain("Gateway disconnected");
    expect(find("[data-banner=disconnected]").textContent).toMatch(
      /^Gateway disconnected since .+ · retrying\. Last confirmed: Paper account /
    );
  });

  it("shows a loading state until the first snapshot arrives", async () => {
    const snapshot = vi.fn(
      () => new Promise<PortfolioMonitorOutput>(() => undefined)
    );
    await mount(<AccountGlance gateway={{ snapshot }} />);
    const loading = find("[data-monitor-state=loading]");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.textContent).toBe("Loading IBKR snapshot");
    expect(health()).toContain("Loading");
  });

  it("renders on the server with the browser ibkr-monitor gateway and without network", () => {
    const html = renderToString(<AccountGlance />);
    expect(html).toContain("Loading IBKR snapshot");
    expect(html).toContain('href="/portfolio"');
  });

  it("shows the human IBKR 2FA control when the gateway is logged out", async () => {
    const loggedOut: IbkrRecoveryStatusOutput = {
      gateway: {
        feedsMissing: false,
        loginState: "logged-out",
        needsLogin: true,
        since: "2026-10-28T14:50:00Z",
        reason: "2fa-timeout",
      },
      request: null,
      cooldownUntil: null,
      canRequest: true,
      checkedAt: "2026-10-28T15:00:00.000Z",
    };
    const recovery = {
      status: vi.fn(async () => loggedOut),
      request: vi.fn(),
    } satisfies IbkrRecoveryGateway;
    await mount(
      <AccountGlance
        gateway={gatewayOf(fixtureSnapshot())}
        recovery={{ configured: true, gateway: recovery }}
      />
    );
    const send = find("[data-account-glance] [data-ibkr-recovery-button]");
    expect(send.textContent).toContain("Send IBKR 2FA request");
    expect(find("[data-ibkr-login]").textContent).toContain(
      "IBKR login: logged out"
    );
    // Nothing is sent without the operator's confirmation.
    expect(recovery.request).not.toHaveBeenCalled();
  });
});
