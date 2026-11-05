// @vitest-environment jsdom
import type {
  VertexComboPreviewOutput,
  VertexFinalGate,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FinalGatePanel } from "./final-gate-panel.tsx";
import { toVerticalInput, VerticalTicket } from "./vertical-ticket.tsx";
import type { VertexOrdersGateway } from "./vertex-orders-client.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional mock data only.
const allow: VertexFinalGate = {
  decision: "allow",
  jevStance: "NEUTRAL",
  jevState: "fresh",
  maxLoss: 800,
  maxLossPct: 0.4,
  reasons: [],
  structure: "debit-vertical",
};
const input = toVerticalInput({
  buyStrike: "100",
  expiry: "2028-01-21",
  netLimit: "4",
  quantity: "2",
  right: "C",
  sellStrike: "110",
  symbol: " mockv ",
});
const preview = (
  gate: VertexFinalGate | null,
  net = 800,
  mode: "simulated" | "live" = "simulated"
): VertexComboPreviewOutput => ({
  confirmToken: gate?.decision === "allow" ? "token-1234567890abcdef" : null,
  expiresAt: null,
  gates: { killSwitch: false, mode, optionsOnly: true, ordersEnabled: false },
  review: {
    accepted: gate?.decision === "allow",
    finalGate: gate,
    label: "MOCKV combo x2",
    netAmount: net,
    order: input,
    reasons:
      gate?.decision === "allow" ? [] : ["Final gate: JEV verdict is none"],
  },
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const gatewayWith = (result: VertexComboPreviewOutput | Error) =>
  ({
    comboPreview: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    comboSubmit: vi.fn(async () => ({
      message: "Simulated",
      mode: "simulated" as const,
      orderRef: "vertex-2",
      permId: 3,
      state: "submitted",
    })),
  }) as unknown as VertexOrdersGateway & {
    comboPreview: ReturnType<typeof vi.fn>;
    comboSubmit: ReturnType<typeof vi.fn>;
  };

const type = async (id: string, value: string) => {
  const el = host.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value"
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(
      new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })
    );
  });
};
const fill = async () => {
  await type("vertical-symbol", "mockv");
  await type("vertical-expiry", "2028-01-21");
  await type("vertical-right", "C");
  await type("vertical-buyStrike", "100");
  await type("vertical-sellStrike", "110");
  await type("vertical-quantity", "2");
  await type("vertical-netLimit", "4");
  await act(async () =>
    (host.querySelector("form") as HTMLFormElement).requestSubmit()
  );
};
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text)
  );

describe("VerticalTicket", () => {
  it("builds one combo with a BUY and a SELL leg", () => {
    expect(input).toEqual({
      legs: [
        { expiry: "20280121", ratio: 1, right: "C", side: "BUY", strike: 100 },
        { expiry: "20280121", ratio: 1, right: "C", side: "SELL", strike: 110 },
      ],
      limitPrice: 4,
      quantity: 2,
      symbol: "MOCKV",
    });
  });

  it("reviews, shows the gate verdict and sends the simulated vertical", async () => {
    const g = gatewayWith(preview(allow));
    const onPlaced = vi.fn(async () => undefined);
    await act(async () =>
      root.render(<VerticalTicket gateway={g} onPlaced={onPlaced} />)
    );
    await fill();
    expect(g.comboPreview).toHaveBeenCalledWith(input);
    expect(host.textContent).toContain("Final JEV gate");
    expect(host.textContent).toContain("Allow");
    expect(host.textContent).toContain("Debit vertical");
    expect(host.textContent).toContain("$800 (0.4% of account, limit 2%)");
    expect(host.textContent).toContain("Net debit $800");
    await act(async () => button("Send vertical (simulated)")?.click());
    expect(g.comboSubmit).toHaveBeenCalledWith({
      confirm: true,
      confirmToken: "token-1234567890abcdef",
      order: input,
    });
    expect(onPlaced).toHaveBeenCalled();
    expect(host.textContent).toContain("Vertical submitted (simulated)");
  });

  it("shows deny reasons, a credit, and no send button; Back returns to the form", async () => {
    const deny: VertexFinalGate = {
      ...allow,
      decision: "deny",
      jevStance: null,
      jevState: "none",
      maxLoss: null,
      maxLossPct: null,
      reasons: ["JEV verdict is none: a fresh verdict is required."],
      structure: "rejected",
    };
    const g = gatewayWith(preview(deny, -300, "live"));
    await act(async () =>
      root.render(
        <VerticalTicket gateway={g} onPlaced={async () => undefined} />
      )
    );
    await fill();
    expect(host.textContent).toContain("Deny");
    expect(host.textContent).toContain("Not a defined-risk structure");
    expect(host.textContent).toContain("n/a");
    expect(host.textContent).toContain("none · none");
    expect(host.textContent).toContain("Net credit $300");
    expect(button("Send vertical")).toBeUndefined();
    await act(async () => button("Back")?.click());
    expect(host.querySelector("form")).not.toBeNull();
  });

  it("shows a server error", async () => {
    const g = gatewayWith(new Error("Too many order requests"));
    await act(async () =>
      root.render(
        <VerticalTicket gateway={g} onPlaced={async () => undefined} />
      )
    );
    await fill();
    expect(host.textContent).toContain("Too many order requests");
  });

  it("names live mode and the live send button", async () => {
    await act(async () => root.render(<FinalGatePanel gate={null} />));
    expect(host.textContent).toBe("");
    const g = gatewayWith(preview(allow, 800, "live"));
    await act(async () =>
      root.render(
        <VerticalTicket gateway={g} onPlaced={async () => undefined} />
      )
    );
    await fill();
    expect(button("Send vertical to IBKR")).toBeDefined();
  });

  it("shows max loss without a percentage when the account value is unknown", async () => {
    await act(async () =>
      root.render(<FinalGatePanel gate={{ ...allow, maxLossPct: null }} />)
    );
    expect(host.textContent).toContain("$800");
    expect(host.textContent).not.toContain("% of account");
  });
});
