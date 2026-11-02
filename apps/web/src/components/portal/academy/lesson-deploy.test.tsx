// @vitest-environment jsdom
import type { Lesson } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import type {
  AcademyDeployRequestOutput,
  AcademyGateOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type { AcademyGateway } from "./academy-client.ts";
import { LessonDeploy } from "./lesson-deploy.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
/** Promise with external settle functions (Promise.withResolvers is outside the TS lib target). */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const strategy = (): Lesson => {
  const lesson = lessonBySlug("covered-call-asymmetry-fixes");
  if (lesson?.backtest === undefined) throw new Error("fixture missing");
  return lesson;
};

const passingGate: AcademyGateOutput = {
  verdict: "pass",
  checks: [{ id: "X03", title: "Defined", status: "pass", detail: "ok" }],
  conflicts: [],
  premiumPerPositionUsd: 1234.4,
  premiumPerPositionPctNlv: 0.5,
  rewardRisk: null,
  nlv: 250_000,
  nlvSource: "portfolio-monitor",
  nlvDetail: "Live feed.",
  statedNlv: null,
  openPremiumInNameUsd: 0,
  otherAllocationsPct: 2,
  unitLossUsd: null,
  structure: "covered_call",
};

const requestOutput = (used: boolean): AcademyDeployRequestOutput => ({
  gate: passingGate,
  request: {
    id: "dr-1",
    status: "requested",
    strategyId: "s",
    strategySlug: "dyr-covered-call",
    mode: "paper",
    executionAuthorized: false,
    brokerSubmissionAllowed: false,
  },
  override: { used, auditId: used ? "a" : null, rules: used ? ["X"] : [] },
});

type Fake = AcademyGateway & { deployPreview: Mock; deployRequest: Mock };

const fakeGateway = (
  preview: (input: unknown) => Promise<AcademyGateOutput>,
  request: () => Promise<AcademyDeployRequestOutput> = async () =>
    requestOutput(false)
): Fake => ({
  tickers: vi.fn(),
  backtest: vi.fn(),
  deployPreview: vi.fn(preview),
  deployRequest: vi.fn(request),
});

const mount = async (lesson: Lesson, gateway: AcademyGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<LessonDeploy gateway={gateway} lesson={lesson} />)
  );
  return { container, root };
};

const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  await act(async () => Promise.resolve());
};

const change = async (
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  await act(async () =>
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    )
  );
};

const query = <T extends Element>(container: HTMLElement, selector: string) =>
  container.querySelector(selector) as T;

describe("LessonDeploy", () => {
  it("renders nothing for a concept lesson", async () => {
    const concept = lessonBySlug("vega-exposure-basics");
    if (concept === null) throw new Error("fixture missing");
    const { container } = await mount(
      concept,
      fakeGateway(async () => passingGate)
    );
    expect(container.innerHTML).toBe("");
  });

  it("previews with every edited field, skips invalid sizes and invalid NLV, and creates a request", async () => {
    const gateway = fakeGateway(async () => passingGate);
    const lesson = strategy();
    const { container } = await mount(lesson, gateway);
    expect(container.textContent).toContain("Checking the rule gates");
    await settle();
    expect(gateway.deployPreview).toHaveBeenCalledTimes(1);
    const verdict = query(container, "[data-gate-verdict]");
    expect(verdict.textContent).toContain("All blocking gates pass.");
    expect(verdict.textContent).toContain("$1,234");
    expect(verdict.textContent).toContain("(0.50% of NLV)");
    expect(verdict.textContent).toContain("$250,000");
    expect(verdict.textContent).toContain("2.0%");
    expect(container.querySelector("[data-override-form]")).toBeNull();
    expect(query<HTMLInputElement>(container, "#deploy-nlv").placeholder).toBe(
      "optional"
    );
    const second = lesson.backtest?.tickers[1] ?? lesson.backtest?.tickers[0];
    await change(query(container, "#deploy-ticker"), String(second));
    await change(query(container, "#deploy-risk"), "10");
    await change(query(container, "#deploy-tranches"), "3");
    await change(query(container, "#deploy-allocation"), "0");
    await settle();
    const calls = gateway.deployPreview.mock.calls.length;
    await change(query(container, "#deploy-allocation"), "4");
    await change(query(container, "#deploy-nlv"), "-5");
    await settle();
    expect(gateway.deployPreview.mock.calls.length).toBe(calls + 1);
    expect(gateway.deployPreview).toHaveBeenLastCalledWith({
      slug: lesson.slug,
      ticker: second,
      allocationPct: 4,
      riskPerTradePct: 10,
      tranches: 3,
    });
    await change(query(container, "#deploy-nlv"), "  ");
    await settle();
    expect(gateway.deployPreview).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ statedNlv: expect.anything() })
    );
    const submit = query<HTMLButtonElement>(container, "[data-deploy-submit]");
    expect(submit.textContent).toBe("Create paper deployment request");
    await act(async () => submit.click());
    expect(gateway.deployRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({ override: expect.anything() })
    );
    const result = query(container, "[data-deploy-result]");
    expect(result.textContent).toContain("dr-1");
    expect(result.textContent).not.toContain("audited override");
  });

  it("shows preview errors, a missing NLV percentage, a creating state and a submit error", async () => {
    let failPreview = true;
    const gate: AcademyGateOutput = {
      ...passingGate,
      premiumPerPositionPctNlv: -1,
      nlv: null,
    };
    const pending = deferred<AcademyDeployRequestOutput>();
    const gateway = fakeGateway(
      async () => {
        if (failPreview) throw new Error("Preview down");
        return gate;
      },
      () => pending.promise
    );
    const { container } = await mount(strategy(), gateway);
    await settle();
    expect(query(container, '[role="alert"]').textContent).toBe("Preview down");
    failPreview = false;
    await change(query(container, "#deploy-risk"), "15");
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const verdict = query(container, "[data-gate-verdict]");
    expect(verdict.textContent).not.toContain("% of NLV");
    expect(verdict.textContent).toContain("NLV: unavailable");
    const nlv = query<HTMLInputElement>(container, "#deploy-nlv");
    expect(nlv.required).toBe(true);
    expect(nlv.placeholder).toBe("required");
    const submit = query<HTMLButtonElement>(container, "[data-deploy-submit]");
    expect(submit.disabled).toBe(true);
    await change(nlv, "100000");
    await settle();
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(submit.textContent).toBe("Creating…");
    expect(submit.disabled).toBe(true);
    await act(async () => pending.reject("bad"));
    expect(query(container, "[data-deploy-error]").textContent).toBe(
      "Request failed"
    );
    expect(submit.disabled).toBe(false);
  });

  it("requires acknowledgment of every conflict, drops stale acknowledgments, and reports the override", async () => {
    const blocked: AcademyGateOutput = {
      ...passingGate,
      verdict: "blocked",
      checks: [
        { id: "A1", title: "Rule A", status: "conflict", detail: "a" },
        { id: "W1", title: "Warn", status: "warn", detail: "w" },
      ],
      conflicts: ["A1", "B2"],
    };
    let gate = blocked;
    const gateway = fakeGateway(
      async () => gate,
      async () => requestOutput(true)
    );
    const { container } = await mount(strategy(), gateway);
    await settle();
    expect(query(container, "[data-gate-verdict]").textContent).toContain(
      "Blocked by 2 rule(s): A1, B2."
    );
    expect(container.textContent).toContain("I knowingly break A1: Rule A");
    expect(container.textContent).toContain("I knowingly break B2: B2");
    expect(container.textContent).toContain("for example A1");
    const ack = (id: string) =>
      query<HTMLInputElement>(container, `[data-ack="${id}"]`);
    await act(async () => ack("A1").click());
    await act(async () => ack("B2").click());
    await act(async () => ack("B2").click());
    expect(ack("B2").checked).toBe(false);
    await act(async () => ack("B2").click());
    gate = { ...blocked, conflicts: ["A1"] };
    await change(query(container, "#deploy-risk"), "12");
    await settle();
    expect(container.querySelector('[data-ack="B2"]')).toBeNull();
    gate = blocked;
    await change(query(container, "#deploy-risk"), "13");
    await settle();
    expect(ack("A1").checked).toBe(true);
    expect(ack("B2").checked).toBe(false);
    await act(async () => ack("B2").click());
    const submit = query<HTMLButtonElement>(container, "[data-deploy-submit]");
    expect(submit.textContent).toBe("Override and create paper request");
    await change(query(container, "#override-password"), "pw");
    await change(query(container, "#override-explanation"), "too short");
    expect(submit.disabled).toBe(true);
    await change(
      query(container, "#override-explanation"),
      "I accept A1 and B2 for this paper request, knowingly."
    );
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(gateway.deployRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        override: {
          password: "pw",
          acknowledged: ["A1", "B2"],
          explanation: expect.stringContaining("A1 and B2"),
        },
      })
    );
    expect(query(container, "[data-deploy-result]").textContent).toContain(
      "with an audited override of X"
    );
  });

  it("ignores previews that resolve or fail after unmount and defaults the ticker to SPY", async () => {
    const base = strategy();
    const preset = base.backtest;
    if (preset === undefined) throw new Error("fixture missing");
    const lesson: Lesson = { ...base, backtest: { ...preset, tickers: [] } };
    const ok = deferred<AcademyGateOutput>();
    const gateway = fakeGateway(() => ok.promise);
    const first = await mount(lesson, gateway);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(gateway.deployPreview).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: "SPY" })
    );
    await act(async () => first.root.unmount());
    roots.splice(0);
    await act(async () => ok.resolve(passingGate));
    const failed = deferred<AcademyGateOutput>();
    const failing = fakeGateway(() => failed.promise);
    const second = await mount(lesson, failing);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => second.root.unmount());
    roots.splice(0);
    await act(async () => failed.reject(new Error("late")));
    expect(failing.deployPreview).toHaveBeenCalledTimes(1);
  });
});
