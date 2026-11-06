// @vitest-environment jsdom
import {
  AccountProfileSchema,
  AddressSchema,
  AdminUsersListOutputSchema,
  PreferencesSchema,
} from "@darkfactory/api";
import {
  BrokerRecoveryStatusSchema,
  ExecutionProjectionSchema,
  VertexGatewayBindingSchema,
} from "@darkfactory/api/vertex";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeController } from "../../components/theme-controller.tsx";
import {
  LAB_ADDRESSES,
  LAB_GATEWAYS,
  LAB_PREFERENCES,
  LAB_PROFILE,
  LAB_USERS,
  labAuditProjections,
  labGatewayStatus,
} from "../fixtures/data-settings.ts";
import { findLabEntry } from "../registry.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import {
  DATA_SETTINGS_LAB_ENTRIES,
  labAdminUsersGateway,
  labAppearanceSelection,
} from "./data-settings.tsx";

afterEach(async () => {
  await unmountLab();
});

const themed = (node: ReactNode) => (
  <ThemeController
    initialPreference={{
      density: "default",
      fontSize: "default",
      radius: "small",
      theme: "default-dark",
    }}
    themeAuthority="trusted"
  >
    {node}
  </ThemeController>
);

/** Visible text plus form state, since account forms show fixture values in fields. */
const content = (host: HTMLElement): string =>
  [
    host.textContent ?? "",
    ...Array.from(
      host.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("input, textarea, select"),
      (field) =>
        field instanceof HTMLInputElement &&
        (field.type === "radio" || field.type === "checkbox")
          ? field.checked
            ? `checked:${field.value}`
            : ""
          : `value:${field.value}`
    ),
  ].join("\n");

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["audit", "Audit", "demo-intent-spy-call-spread"],
  ["modules", "Modules", "demo-momentum-scanner"],
  ["connections", "Connections", "demo-gateway-paper"],
  ["settings-profile", "Settings", "value:Demo Analyst"],
  ["settings-address", "Settings", "100 Example Avenue"],
  ["settings-preferences", "Settings", "value:members"],
  ["settings-security", "Settings", "DemoBrowser"],
  ["settings-administration", "Settings", "Demo Trader"],
  ["settings-appearance", "Settings", "Theme"],
  ["settings-workspace", "Settings", "Session privacy and temporary data"],
];

describe("data and settings lab entries", () => {
  it.each(CASES)("renders %s with fake data", async (id, title, fake) => {
    const entry = findLabEntry(DATA_SETTINGS_LAB_ENTRIES, id);
    const host = await mountLab(themed(entry?.render(new URLSearchParams())));
    // The audit ledger verifies its hash chain asynchronously; wait for it under load.
    await vi.waitFor(() => expect(content(host)).toContain(fake));
    expect(host.querySelector("h1")?.textContent).toBe(title);
  });

  it("serves valid contract fixtures", async () => {
    for (const value of await labAuditProjections())
      expect(ExecutionProjectionSchema.parse(value)).toEqual(value);
    for (const gateway of LAB_GATEWAYS) {
      VertexGatewayBindingSchema.parse(gateway);
      BrokerRecoveryStatusSchema.parse(labGatewayStatus(gateway));
    }
    AccountProfileSchema.parse(LAB_PROFILE);
    for (const address of LAB_ADDRESSES) AddressSchema.parse(address);
    PreferencesSchema.parse(LAB_PREFERENCES);
    AdminUsersListOutputSchema.parse(LAB_USERS);
  });

  it("filters the fictional directory and ignores appearance choices", async () => {
    const found = await labAdminUsersGateway.list({
      limit: 20,
      query: "Reviewer",
    });
    expect(found.items.map((user) => user.name)).toEqual(["Demo Reviewer"]);
    expect(
      labAppearanceSelection.select({
        density: "compact",
        fontSize: "large",
        radius: "none",
        theme: "default-light",
      })
    ).toBeUndefined();
  });
});
