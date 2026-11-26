import { describe, expect, it } from "vitest";
import {
  brokerHandshakeLabel,
  continuityStateLabel,
  freshnessStatusLabel,
  gatewayInfrastructureLabel,
  gatewayRecoveryLabel,
  leakageCheckStatusLabel,
  moduleLifecycleStateLabel,
  reservationStateLabel,
} from "./status-labels.ts";

describe("experience wire-value status labels", () => {
  it("maps continuity states without printing raw unavailable", () => {
    expect(continuityStateLabel("unavailable")).toBe("source reported no data");
    expect(continuityStateLabel("continuous")).toBe("continuous");
    expect(continuityStateLabel("gap")).toBe("gap");
  });

  it("maps reservation states without printing raw unknown", () => {
    expect(reservationStateLabel("unknown")).toBe(
      "not confirmed by native owner"
    );
    expect(reservationStateLabel("reserved")).toBe("reserved");
    expect(reservationStateLabel("spent")).toBe("spent");
    expect(reservationStateLabel("released")).toBe("released");
  });

  it("maps freshness statuses without printing raw unknown", () => {
    expect(freshnessStatusLabel("unknown")).toBe("not evaluated by source");
    expect(freshnessStatusLabel("fresh")).toBe("fresh");
    expect(freshnessStatusLabel("stale")).toBe("stale");
    expect(freshnessStatusLabel("missing")).toBe("missing");
  });

  it("maps gateway infrastructure, broker handshake and recovery without raw unavailable or unknown", () => {
    expect(gatewayInfrastructureLabel("unavailable")).toBe(
      "not reachable by status probe"
    );
    expect(gatewayInfrastructureLabel("unknown")).toBe(
      "not reported by status probe"
    );
    expect(gatewayInfrastructureLabel("observed")).toBe("observed");

    expect(brokerHandshakeLabel("unavailable")).toBe(
      "handshake probe could not reach broker"
    );
    expect(brokerHandshakeLabel("unknown")).toBe(
      "not reported by status probe"
    );
    expect(brokerHandshakeLabel("authenticated")).toBe("authenticated");

    expect(gatewayRecoveryLabel("unknown")).toBe(
      "not reported by status probe"
    );
    expect(gatewayRecoveryLabel("completed")).toBe("completed");
  });

  it("maps leakage check statuses without printing raw unknown", () => {
    expect(leakageCheckStatusLabel("unknown")).toBe(
      "not reported by backtest runner"
    );
    expect(leakageCheckStatusLabel("passed")).toBe("passed");
    expect(leakageCheckStatusLabel("failed")).toBe("failed");
    expect(leakageCheckStatusLabel("not-run")).toBe("not-run");
  });

  it("maps module lifecycle states without printing raw unavailable or unknown", () => {
    expect(moduleLifecycleStateLabel("unavailable")).toBe(
      "not reachable in catalog"
    );
    expect(moduleLifecycleStateLabel("unknown")).toBe(
      "not reported by catalog"
    );
    expect(moduleLifecycleStateLabel("active-read-only")).toBe(
      "active-read-only"
    );
  });
});
