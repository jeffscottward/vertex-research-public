// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { describeClick, describeSubmit, isImportantLabel } from "./describe.ts";

const page = { origin: "http://localhost:3000", pathname: "/assistant" };

const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};

const at = (selector: string) => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("describeClick", () => {
  it("records a button by its visible text and marks Stop as important", () => {
    mount(
      '<button data-testid="assistant-stop" type="button"><svg aria-hidden="true"></svg><span>Stop</span></button>'
    );
    expect(describeClick(at("span"), page)).toEqual({
      important: true,
      kind: "click",
      label: "Stop",
      role: "button",
      route: "/assistant",
      targetRoute: null,
      testId: "assistant-stop",
    });
  });

  it("records internal links by path and external links by origin only", () => {
    mount(
      '<a href="/dashboard?tab=risk#top">Dashboard</a><a href="https://example.test/path?token=abc">Docs</a>'
    );
    expect(describeClick(at('a[href^="/"]'), page)).toMatchObject({
      important: false,
      label: "Dashboard",
      role: "link",
      targetRoute: "/dashboard",
    });
    expect(describeClick(at('a[href^="https"]'), page)).toMatchObject({
      label: "Docs",
      targetRoute: "https://example.test",
    });
  });

  it("prefers the author's labels and redacts numbers on screen", () => {
    mount(`
      <div role="menuitemcheckbox" aria-label="Show closed">x</div>
      <span id="l1">Sell</span><span id="l2">AAPL 10 @ $187.42</span>
      <div role="button" aria-labelledby="l1 l2">ignored</div>
      <div role="tab" aria-labelledby="missing" title="Positions">  </div>
      <button aria-label="  ">Buy 1,250 shares</button>
      <summary>Details</summary>
      <div role="widget-unknown"><button>Plain</button></div>
      <div role="switch" aria-label="Alerts"></div>
      <div role="option"></div>
    `);
    expect(describeClick(at('[role="menuitemcheckbox"]'), page)).toMatchObject({
      label: "Show closed",
      role: "menuitem",
    });
    expect(describeClick(at('[aria-labelledby="l1 l2"]'), page)).toMatchObject({
      important: true,
      label: "Sell AAPL # @ #",
      role: "button",
    });
    expect(describeClick(at('[role="tab"]'), page)).toMatchObject({
      label: "Positions",
      role: "tab",
    });
    expect(describeClick(at('button[aria-label="  "]'), page)).toMatchObject({
      label: "Buy # shares",
    });
    expect(describeClick(at("summary"), page)).toMatchObject({
      role: "summary",
    });
    expect(describeClick(at('[role="switch"]'), page)).toMatchObject({
      label: "Alerts",
      role: "switch",
    });
    expect(describeClick(at('[role="option"]'), page)).toMatchObject({
      label: "",
      role: "option",
    });
  });

  it("labels checkboxes and radios from their label element, never their value", () => {
    mount(`
      <label for="c">Include options</label><input id="c" type="checkbox" value="secret-1">
      <input id="r" type="radio" value="secret-2">
      <input type="submit" value="secret-3">
    `);
    expect(describeClick(at("#c"), page)).toMatchObject({
      label: "Include options",
      role: "checkbox",
    });
    expect(describeClick(at("#r"), page)).toMatchObject({
      label: "",
      role: "radio",
    });
    const submit = describeClick(at('[type="submit"]'), page);
    expect(submit).toMatchObject({ label: "", role: "button" });
    expect(JSON.stringify(submit)).not.toContain("secret");
  });

  it("never records text entry, plain text or non-elements", () => {
    mount(`
      <input id="t" value="typed">
      <textarea>typed</textarea>
      <select><option>typed</option></select>
      <div contenteditable="true"><button>Inside editor</button></div>
      <p id="plain">Just text</p>
    `);
    for (const selector of [
      "#t",
      "textarea",
      "select",
      "div button",
      "#plain",
    ]) {
      expect(describeClick(at(selector), page)).toBeNull();
    }
    expect(describeClick(null, page)).toBeNull();
    expect(describeClick(document, page)).toBeNull();
  });

  it("never reads user-entered text inside a private container", () => {
    mount(`
      <ul data-click-private>
        <li><button aria-label="Open my secret plan">My secret plan</button></li>
        <li><a href="/todos/1" data-click-label="Open to-do">Call broker about 401k</a></li>
      </ul>
      <button data-click-label="Open thread">typed title</button>
    `);
    const [thread, todo] = [...document.querySelectorAll("li > *")];
    expect(describeClick(thread ?? null, page)).toMatchObject({
      label: "[private]",
    });
    expect(describeClick(todo ?? null, page)).toMatchObject({
      label: "Open to-do",
      targetRoute: "/todos/1",
    });
    expect(describeClick(at("body > button"), page)).toMatchObject({
      label: "Open thread",
    });
    expect(document.body.textContent).toContain("secret");
  });

  it("never stores long visible text, even outside a private container", () => {
    mount(`
      <button>Write a plan for my retirement savings this year</button>
      <button>${"x".repeat(41)}</button>
      <button>Run full walk-forward backtest</button>
      <button aria-label="Open the quarterly research plan for review now">x</button>
    `);
    const [sentence, long, short, authored] = [
      ...document.querySelectorAll("button"),
    ];
    expect(describeClick(sentence ?? null, page)?.label).toBe("[text]");
    expect(describeClick(long ?? null, page)?.label).toBe("[text]");
    expect(describeClick(short ?? null, page)?.label).toBe(
      "Run full walk-forward backtest"
    );
    expect(describeClick(authored ?? null, page)?.label).toBe(
      "Open the quarterly research plan for review now"
    );
  });

  it("redacts secret-looking route segments", () => {
    mount("<button>Open</button>");
    expect(
      describeClick(at("button"), {
        ...page,
        pathname: `/reset/${"a1".repeat(30)}`,
      })
    ).toMatchObject({ route: "/reset/[redacted]" });
  });
});

describe("describeSubmit", () => {
  it("records the form name only and marks it important", () => {
    mount(`
      <form aria-label="Assistant message" data-testid="composer"><textarea>typed secret</textarea></form>
      <form name="order-form"></form>
      <form id="search"></form>
      <form class="anonymous"></form>
      <form aria-label="Edit MYBASKET" data-click-private></form>
      <form aria-label="Edit MYBASKET" data-click-private data-click-label="Edit basket"></form>
    `);
    const forms = [...document.querySelectorAll("form")];
    expect(describeSubmit(forms[0] ?? null, page)).toEqual({
      important: true,
      kind: "submit",
      label: "Assistant message",
      role: "form",
      route: "/assistant",
      targetRoute: null,
      testId: "composer",
    });
    expect(describeSubmit(forms[1] ?? null, page)?.label).toBe("order-form");
    expect(describeSubmit(forms[2] ?? null, page)?.label).toBe("search");
    expect(describeSubmit(forms[3] ?? null, page)?.label).toBe("form");
    expect(describeSubmit(forms[4] ?? null, page)?.label).toBe("[private]");
    expect(describeSubmit(forms[5] ?? null, page)?.label).toBe("Edit basket");
    expect(describeSubmit(at("textarea"), page)).toBeNull();
  });
});

describe("isImportantLabel", () => {
  it("matches state-changing actions only", () => {
    for (const label of [
      "Stop",
      "Send",
      "Review order",
      "Send cancel",
      "Arm",
      "Disarm",
      "Approve and run",
      "Reject",
      "Confirm",
      "Cancel review",
      "Pause new risk",
      "Submit",
      "Buy",
      "Sell",
      "Liquidate all",
    ]) {
      expect(isImportantLabel(label)).toBe(true);
    }
    for (const label of ["Dashboard", "Stopwatch", "Ordering help", "Open"]) {
      expect(isImportantLabel(label)).toBe(false);
    }
  });
});
