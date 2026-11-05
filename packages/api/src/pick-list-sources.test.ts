import { describe, expect, it } from "vitest";

import {
  createPickListSourceRegistry,
  jsonFileSource,
  type PickListSource,
  PickListSourceError,
  WISHLIST_SOURCE,
  wishlistTomlSource,
} from "./pick-list-sources.ts";

const sourceWith = (id: string): PickListSource => ({
  id,
  label: `${id} label`,
  load: async () => [],
});

const jsonSource = (text: string, asOf?: string) =>
  jsonFileSource({
    id: "json",
    label: "JSON file",
    read: async () => text,
    ...(asOf === undefined ? {} : { asOf }),
  });

describe("createPickListSourceRegistry", () => {
  it("finds sources by id and lists the ids", () => {
    const registry = createPickListSourceRegistry([
      sourceWith("json"),
      sourceWith("wishlist"),
    ]);
    expect(registry.ids()).toEqual(["json", "wishlist"]);
    expect(registry.get("wishlist")?.label).toBe("wishlist label");
    expect(registry.get("missing")).toBeNull();
  });

  it("rejects duplicate and malformed ids", () => {
    expect(() =>
      createPickListSourceRegistry([sourceWith("json"), sourceWith("json")])
    ).toThrow(new PickListSourceError("Duplicate source id: json"));
    expect(() => createPickListSourceRegistry([sourceWith("Bad Id")])).toThrow(
      "Invalid source id: Bad Id"
    );
  });
});

describe("jsonFileSource", () => {
  it("reads a lists document as manual snapshots", async () => {
    const source = jsonSource(
      JSON.stringify({
        source: "newsletter",
        sourceLabel: "Monthly newsletter",
        lists: [
          {
            slug: "core",
            name: "Core picks",
            asOf: "2026-11-01",
            method: "adapter",
            members: [{ symbol: "aapl", rank: 1, targetPrice: 250 }],
          },
          {
            slug: "growth",
            name: "Growth",
            members: [{ symbol: "MSFT" }],
          },
        ],
      }),
      "2026-11-04"
    );
    expect(source.id).toBe("json");
    expect(source.label).toBe("JSON file");
    await expect(source.load()).resolves.toEqual([
      {
        source: "newsletter",
        sourceLabel: "Monthly newsletter",
        list: { slug: "core", name: "Core picks" },
        asOf: "2026-11-01",
        method: "manual",
        members: [{ symbol: "AAPL", rank: 1, targetPrice: 250 }],
      },
      {
        source: "newsletter",
        sourceLabel: "Monthly newsletter",
        list: { slug: "growth", name: "Growth" },
        asOf: "2026-11-04",
        method: "manual",
        members: [{ symbol: "MSFT" }],
      },
    ]);
  });

  it("reads one snapshot in the import shape", async () => {
    const snapshot = {
      source: "strategy",
      sourceLabel: "Strategy holdings",
      list: { slug: "value", name: "Value" },
      asOf: "2026-10-31",
      method: "adapter",
      members: [{ symbol: "XOM", sector: "Energy" }],
    };
    await expect(jsonSource(JSON.stringify(snapshot)).load()).resolves.toEqual([
      { ...snapshot, method: "manual" },
    ]);
  });

  it("names the invalid list and field", async () => {
    await expect(
      jsonSource(
        JSON.stringify({
          source: "newsletter",
          sourceLabel: "Monthly newsletter",
          lists: [{ slug: "core", name: "Core", members: [] }],
        })
      ).load()
    ).rejects.toThrow(
      /^lists\[0\] is not a valid pick list: asOf: .+; members: /u
    );
    await expect(jsonSource("{}").load()).rejects.toThrow(
      /^The file is not a valid pick list: /u
    );
  });

  it("reports the root of a document that is not an object", async () => {
    await expect(jsonSource("[1]").load()).rejects.toThrow(
      "The file must hold a JSON object (a lists document or one snapshot)"
    );
    await expect(jsonSource("not json").load()).rejects.toThrow(
      new PickListSourceError("The file is not valid JSON")
    );
  });

  it("passes read failures through", async () => {
    const failing = jsonFileSource({
      id: "json",
      label: "JSON file",
      read: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    await expect(failing.load()).rejects.toThrow("ENOENT: no such file");
  });
});

describe("wishlistTomlSource", () => {
  const load = (document: unknown) =>
    wishlistTomlSource({ read: async () => document, asOf: "2026-11-05" });

  it("imports enabled symbols with notes as the thesis", async () => {
    const source = load({
      symbol: [
        { symbol: "META", enabled: true, budget_usd: 5000, note: " dip " },
        { symbol: "tsla", note: "" },
        { symbol: "LRCX", enabled: false, note: "paused" },
        { symbol: "QQQ", enabled: true, note: "x".repeat(2100) },
      ],
    });
    expect(source.id).toBe(WISHLIST_SOURCE.source);
    expect(source.label).toBe("Owner wish list");
    const [snapshot] = await source.load();
    expect(snapshot).toEqual({
      source: "wishlist",
      sourceLabel: "Owner wish list",
      list: { slug: "wishlist", name: "Wish list" },
      asOf: "2026-11-05",
      method: "manual",
      members: [
        { symbol: "META", thesis: "dip" },
        { symbol: "TSLA" },
        { symbol: "QQQ", thesis: "x".repeat(2000) },
      ],
    });
  });

  it("rejects a malformed or empty wish list", async () => {
    await expect(load({ symbol: [{ enabled: true }] }).load()).rejects.toThrow(
      /^The wish list is not valid: symbol\.0\.symbol: /u
    );
    await expect(load({}).load()).rejects.toThrow(
      "The wish list has no enabled symbols"
    );
    await expect(load(null).load()).rejects.toThrow(
      /^The wish list is not valid: \(root\): /u
    );
  });

  it("validates the snapshot", async () => {
    await expect(
      wishlistTomlSource({
        read: async () => ({ symbol: [{ symbol: "META" }] }),
        asOf: "yesterday",
      }).load()
    ).rejects.toThrow(/^The wish list is not a valid pick list: asOf: /u);
  });
});
