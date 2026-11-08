// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  ATTRIBUTE_NOT_CERTIFIED_TEXT,
  CATALOG_UNAVAILABLE_TEXT,
  CERTIFY_CONFLICT_TEXT,
  createBrowserSemanticTermsGateway,
  describeSemanticFailure,
  NOT_CERTIFIED_TEXT,
  READ_ONLY_TEXT,
  type SemanticCatalog,
  type SemanticTermsGateway,
  SemanticTermsWorkspace,
} from "./semantic-terms-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
});

const audit = {
  updatedAt: "2026-11-01T10:00:00.000Z",
  updatedBy: "op@example.com",
};
const certifiedBy = {
  certificationNote: "Checked against IBKR",
  certified: true,
  certifiedAt: "2026-11-02T14:30:00.000Z",
  certifiedBy: "op@example.com",
  ...audit,
};
const uncertified = {
  certificationNote: null,
  certified: false,
  certifiedAt: null,
  certifiedBy: null,
  ...audit,
};

const catalog = (): SemanticCatalog => ({
  attributes: [
    {
      description: "Sum of closed trades",
      grain: "run_spec",
      id: "realized_pnl_sql",
      sql: "select sum(pnl) from trades",
      termId: "realized_pnl",
      ...uncertified,
    },
  ],
  canWrite: true,
  relationships: [
    {
      cardinality: "many_to_one",
      description: "Trade belongs to account",
      fromColumn: "account_id",
      fromTable: "trades",
      id: "trades_accounts",
      toColumn: "id",
      toTable: "accounts",
      ...certifiedBy,
      certificationNote: null,
      certifiedAt: null,
      certifiedBy: null,
    },
  ],
  terms: [
    {
      description: "Closed trade profit",
      feedPath: null,
      id: "realized_pnl",
      label: "Realized P&L",
      mappedColumns: [],
      params: [],
      source: "postgres",
      synonyms: ["pnl", "profit"],
      unit: "USD",
      ...certifiedBy,
    },
    {
      description: "Account value",
      feedPath: "/account",
      id: "net_liq",
      label: "Net liquidation",
      mappedColumns: [],
      params: [],
      source: "feed",
      synonyms: [],
      unit: "",
      ...uncertified,
      certifiedAt: null,
      certifiedBy: null,
    },
  ],
});

type FakeGateway = Record<keyof SemanticTermsGateway, Mock>;

const fakeGateway = (overrides: Partial<FakeGateway> = {}): FakeGateway => ({
  catalog: vi.fn(async () => catalog()),
  certify: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => ({ ok: true })),
  ...overrides,
});

const mount = async (gateway?: SemanticTermsGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      gateway === undefined ? (
        <SemanticTermsWorkspace />
      ) : (
        <SemanticTermsWorkspace gateway={gateway} />
      )
    )
  );
  return container;
};

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const buttonIn = (root: ParentNode, text: string) => {
  const button = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`No button ${text}`);
  return button;
};

const click = (element: HTMLElement) => act(async () => element.click());

const term = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-term="${id}"]`) as HTMLElement;

const submit = (form: HTMLFormElement) =>
  act(async () => {
    form.requestSubmit();
  });

const field = (form: ParentNode, label: string) => {
  const target = Array.from(form.querySelectorAll("label")).find(
    (candidate) => candidate.textContent === label
  );
  return form.querySelector(`#${CSS.escape(target?.htmlFor ?? "")}`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
};

describe("describeSemanticFailure", () => {
  it("maps 403, 503 and 401 by code or status", () => {
    expect(describeSemanticFailure({ code: "FORBIDDEN" }).kind).toBe(
      "forbidden"
    );
    expect(describeSemanticFailure({ status: 403 })).toEqual({
      kind: "forbidden",
      message: "Operator access required.",
    });
    expect(describeSemanticFailure({ code: "STORAGE_ERROR" })).toEqual({
      kind: "unavailable",
      message: CATALOG_UNAVAILABLE_TEXT,
    });
    expect(describeSemanticFailure({ status: 503 }).kind).toBe("unavailable");
    expect(describeSemanticFailure({ code: "UNAUTHORIZED" }).message).toBe(
      "Session expired. Sign in again."
    );
    expect(describeSemanticFailure({ status: 401 }).message).toBe(
      "Session expired. Sign in again."
    );
    expect(describeSemanticFailure(new Error("boom"))).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(describeSemanticFailure(null).message).toBe("Unknown error");
  });
});

describe("createBrowserSemanticTermsGateway", () => {
  it("creates one client lazily on the page origin and forwards inputs", async () => {
    const api = {
      catalog: vi.fn(async () => catalog()),
      certify: vi.fn(async () => ({ ok: true })),
      update: vi.fn(async () => ({ ok: true })),
    };
    runtime.client = { semanticTerms: api } as unknown as ApiClient;
    const gateway = createBrowserSemanticTermsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.catalog();
    await gateway.update({ id: "trades_accounts", kind: "relationship" });
    await gateway.certify({
      certified: true,
      expectedUpdatedAt: audit.updatedAt,
      id: "net_liq",
      kind: "term",
      note: null,
    });
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(api.catalog).toHaveBeenCalledWith({});
    expect(api.update).toHaveBeenCalledWith({
      id: "trades_accounts",
      kind: "relationship",
    });
    expect(api.certify).toHaveBeenCalledWith({
      certified: true,
      expectedUpdatedAt: audit.updatedAt,
      id: "net_liq",
      kind: "term",
      note: null,
    });
  });

  it("is used when no gateway is supplied", async () => {
    runtime.client = {
      semanticTerms: { catalog: vi.fn(async () => catalog()) },
    } as unknown as ApiClient;
    const container = await mount();
    await act(async () => undefined);
    expect(term(container, "realized_pnl")).not.toBeNull();
  });
});

describe("SemanticTermsWorkspace", () => {
  it("shows loading, then terms, attributes, relationships and certification", async () => {
    // The app's TypeScript lib predates Promise.withResolvers.
    let resolve: (value: SemanticCatalog) => void = () => undefined;
    const pending = new Promise<SemanticCatalog>((done) => {
      resolve = done;
    });
    const gateway = fakeGateway({ catalog: vi.fn(() => pending) });
    const container = await mount(gateway);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading semantic terms…"
    );
    await act(async () => resolve(catalog()));

    expect(container.textContent).toContain(
      "2 terms, 1 not certified; 1 SQL attributes, 1 need owner certification."
    );
    const pnl = term(container, "realized_pnl");
    expect(pnl.textContent).toContain("Realized P&L");
    expect(pnl.textContent).toContain("realized_pnl");
    expect(pnl.textContent).toContain("postgres");
    expect(pnl.textContent).toContain("USD");
    expect(pnl.textContent).toContain("pnl, profit");
    expect(pnl.textContent).toContain("Certified");
    expect(pnl.textContent).toContain("11/2/26, 2:30 PM by op@example.com");
    expect(pnl.textContent).toContain("Note: Checked against IBKR");
    // The certified term's SQL attribute is not certified yet.
    const attribute = pnl.querySelector('[data-attribute="realized_pnl_sql"]');
    expect(attribute?.querySelector("pre code")?.textContent).toBe(
      "select sum(pnl) from trades"
    );
    expect(
      attribute?.querySelector('[data-uncertified="true"]')?.textContent
    ).toBe(ATTRIBUTE_NOT_CERTIFIED_TEXT);
    expect(
      attribute?.querySelector('[data-grain="run_spec"]')?.textContent
    ).toBe(
      "Rows: per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy"
    );

    const liq = term(container, "net_liq");
    expect(liq.getAttribute("data-certified")).toBe("false");
    expect(liq.querySelector('[data-uncertified="true"]')?.textContent).toBe(
      NOT_CERTIFIED_TEXT
    );
    expect(liq.textContent).toContain("No SQL attribute for this term.");
    expect(liq.querySelector("dl")?.textContent).toContain("Unit—Synonyms—");

    const relationship = container.querySelector(
      '[data-relationship="trades_accounts"]'
    );
    expect(relationship?.textContent).toContain("trades.account_id");
    expect(relationship?.textContent).toContain("accounts.id");
    expect(relationship?.textContent).toContain("many_to_one");
    expect(relationship?.textContent).toContain("unknown time by unknown");
    expect(relationship?.textContent).not.toContain("Note:");
  });

  it("shows empty catalog states", async () => {
    const container = await mount(
      fakeGateway({
        catalog: vi.fn(async () => ({
          attributes: [],
          relationships: [],
          terms: [],
        })),
      })
    );
    expect(container.textContent).toContain("The catalog has no terms.");
    expect(container.textContent).toContain("No relationships in the catalog.");
  });

  it("shows operator access required on 403", async () => {
    const container = await mount(
      fakeGateway({
        catalog: vi.fn(async () => {
          throw Object.assign(new Error("Forbidden"), { status: 403 });
        }),
      })
    );
    const notice = container.querySelector("[data-operator-access]");
    expect(notice?.getAttribute("data-operator-feature")).toBe(
      "semantic-terms"
    );
    expect(notice?.textContent).toContain("Operator access required");
  });

  it("shows catalog unavailable on 503 and retries", async () => {
    const gateway = fakeGateway({
      catalog: vi
        .fn()
        .mockRejectedValueOnce({ code: "STORAGE_ERROR", status: 503 })
        .mockResolvedValueOnce(catalog()),
    });
    const container = await mount(gateway);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      CATALOG_UNAVAILABLE_TEXT
    );
    await click(buttonIn(container, "Retry now"));
    expect(term(container, "realized_pnl")).not.toBeNull();
  });

  it("certifies with a note, removes certification and refreshes after each write", async () => {
    const gateway = fakeGateway();
    const container = await mount(gateway);
    const liq = term(container, "net_liq");
    await setValue(
      field(liq, "Certification note (optional)"),
      "  Matches TWS  "
    );
    await click(buttonIn(liq, "Certify"));
    expect(gateway.certify).toHaveBeenCalledWith({
      certified: true,
      expectedUpdatedAt: audit.updatedAt,
      id: "net_liq",
      kind: "term",
      note: "Matches TWS",
    });
    expect(gateway.catalog).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-notice="success"]')?.textContent
    ).toBe("Certified term net_liq.");
    expect(
      (
        field(
          term(container, "net_liq"),
          "Certification note (optional)"
        ) as HTMLInputElement
      ).value
    ).toBe("");

    await click(
      buttonIn(term(container, "realized_pnl"), "Remove certification")
    );
    expect(gateway.certify).toHaveBeenLastCalledWith({
      certified: false,
      expectedUpdatedAt: audit.updatedAt,
      id: "realized_pnl",
      kind: "term",
      note: null,
    });
    expect(gateway.catalog).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector('[data-notice="success"]')?.textContent
    ).toBe("Removed certification from term realized_pnl.");
  });

  it("shows a write failure, keeps the note and still refreshes", async () => {
    const gateway = fakeGateway({
      certify: vi.fn(async () => {
        throw { code: "FORBIDDEN" };
      }),
    });
    const container = await mount(gateway);
    const relationship = container.querySelector(
      '[data-relationship="trades_accounts"]'
    ) as HTMLElement;
    await setValue(field(relationship, "Certification note (optional)"), "x");
    await click(buttonIn(relationship, "Remove certification"));
    expect(container.querySelector('[data-notice="error"]')?.textContent).toBe(
      "Operator access required."
    );
    expect(gateway.catalog).toHaveBeenCalledTimes(2);
    expect(
      (field(relationship, "Certification note (optional)") as HTMLInputElement)
        .value
    ).toBe("x");
  });

  it("shows the conflict text on 409 and reloads the catalog", async () => {
    const gateway = fakeGateway({
      certify: vi.fn(async () => {
        throw { code: "CONFLICT", status: 409 };
      }),
    });
    const container = await mount(gateway);
    await click(buttonIn(term(container, "net_liq"), "Certify"));
    expect(container.querySelector('[data-notice="error"]')?.textContent).toBe(
      CERTIFY_CONFLICT_TEXT
    );
    expect(gateway.catalog).toHaveBeenCalledTimes(2);
    expect(describeSemanticFailure({ status: 409 }).kind).toBe("conflict");
  });

  it("hides edit and certify controls when canWrite is false", async () => {
    const gateway = fakeGateway({
      catalog: vi.fn(async () => ({ ...catalog(), canWrite: false })),
    });
    const container = await mount(gateway);
    const buttons = [...container.querySelectorAll("button")].map(
      (button) => button.textContent
    );
    expect(
      buttons.some((text) =>
        /^(Edit|Certify|Remove certification)/.test(text ?? "")
      )
    ).toBe(false);
    expect(
      container.querySelectorAll('[data-read-only="true"]').length
    ).toBeGreaterThan(0);
    expect(container.textContent).toContain(READ_ONLY_TEXT);
  });

  it("edits a term: only changed fields, synonyms split, certification removed", async () => {
    const gateway = fakeGateway();
    const container = await mount(gateway);
    const pnl = term(container, "realized_pnl");
    await click(buttonIn(pnl, "Edit term"));
    const form = pnl.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("aria-label")).toBe("Edit term realized_pnl");

    await submit(form);
    expect(form.querySelector('[role="status"]')?.textContent).toBe(
      "No changes to save."
    );
    expect(gateway.update).not.toHaveBeenCalled();

    await setValue(field(form, "Label"), "Realized PnL");
    await setValue(
      field(form, "Synonyms (comma-separated)"),
      "pnl, , closed profit ,"
    );
    await submit(form);
    expect(gateway.update).toHaveBeenCalledWith({
      id: "realized_pnl",
      kind: "term",
      label: "Realized PnL",
      synonyms: ["pnl", "closed profit"],
    });
    expect(
      container.querySelector('[data-notice="success"]')?.textContent
    ).toBe(
      "Saved term realized_pnl. Its certification was removed: certify it again before the assistant uses it."
    );
    expect(pnl.querySelector("form")).toBeNull();
    expect(gateway.catalog).toHaveBeenCalledTimes(2);
  });

  it("edits a term without touching synonyms and cancels", async () => {
    const gateway = fakeGateway();
    const container = await mount(gateway);
    const liq = term(container, "net_liq");
    await click(buttonIn(liq, "Edit term"));
    let form = liq.querySelector("form") as HTMLFormElement;
    await setValue(field(form, "Unit"), "USD");
    await submit(form);
    expect(gateway.update).toHaveBeenCalledWith({
      id: "net_liq",
      kind: "term",
      unit: "USD",
    });

    await click(buttonIn(liq, "Edit term"));
    form = liq.querySelector("form") as HTMLFormElement;
    await click(buttonIn(form, "Cancel"));
    expect(liq.querySelector("form")).toBeNull();
  });

  it("edits an attribute's SQL and keeps the form open on failure", async () => {
    const gateway = fakeGateway({
      update: vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce({ ok: true }),
    });
    const container = await mount(gateway);
    const attribute = container.querySelector(
      '[data-attribute="realized_pnl_sql"]'
    ) as HTMLElement;
    await click(buttonIn(attribute, "Edit attribute"));
    const form = attribute.querySelector("form") as HTMLFormElement;
    const sql = field(form, "SQL");
    expect(sql).toBeInstanceOf(HTMLTextAreaElement);
    expect(sql.className).toContain("font-mono");
    await setValue(sql, "select 1");
    await submit(form);
    expect(gateway.update).toHaveBeenCalledWith({
      id: "realized_pnl_sql",
      kind: "attribute",
      sql: "select 1",
    });
    expect(container.querySelector('[data-notice="error"]')?.textContent).toBe(
      CATALOG_UNAVAILABLE_TEXT
    );
    expect(attribute.querySelector("form")).not.toBeNull();

    await setValue(field(form, "Description"), "New description");
    await submit(form);
    expect(gateway.update).toHaveBeenLastCalledWith({
      description: "New description",
      id: "realized_pnl_sql",
      kind: "attribute",
      sql: "select 1",
    });
    expect(attribute.querySelector("form")).toBeNull();
  });

  it("edits a relationship description", async () => {
    const gateway = fakeGateway();
    const container = await mount(gateway);
    const relationship = container.querySelector(
      '[data-relationship="trades_accounts"]'
    ) as HTMLElement;
    await click(buttonIn(relationship, "Edit relationship"));
    const form = relationship.querySelector("form") as HTMLFormElement;
    await setValue(field(form, "Description"), "Each trade has one account");
    await submit(form);
    expect(gateway.update).toHaveBeenCalledWith({
      description: "Each trade has one account",
      id: "trades_accounts",
      kind: "relationship",
    });
  });
});
