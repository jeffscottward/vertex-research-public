import { SEMANTIC_ATTRIBUTE_GRAINS as DB_GRAINS } from "@darkfactory/db/schema";
import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  SEMANTIC_ATTRIBUTE_GRAINS,
  SEMANTIC_QUERY_MAX_ROWS,
  SEMANTIC_TERMS_API_ERRORS,
  SemanticCatalogCertifyInputSchema,
  SemanticCatalogOutputSchema,
  SemanticCatalogUpdateInputSchema,
  SemanticParamSpecSchema,
  SemanticTermQueryInputSchema,
  SemanticTermQueryOutputSchema,
  semanticTermsContract,
} from "./contracts/semantic-terms.ts";

describe("semanticTerms contract", () => {
  it("is registered on the app contract with five procedures", () => {
    expect(appContract.semanticTerms).toBe(semanticTermsContract);
    expect(Object.keys(appContract.semanticTerms).sort()).toEqual([
      "catalog",
      "certify",
      "list",
      "query",
      "update",
    ]);
  });

  it("names the same SQL attribute grains as the database check", () => {
    expect(SEMANTIC_ATTRIBUTE_GRAINS).toEqual(DB_GRAINS);
  });

  it("pins the method, path and operation id of every route", () => {
    expect(
      Object.fromEntries(
        Object.entries(semanticTermsContract).map(([name, procedure]) => {
          const { method, operationId, path } = procedure["~orpc"].route;
          return [name, [method, path, operationId]];
        })
      )
    ).toEqual({
      catalog: ["GET", "/semantic-terms/catalog", "semanticTerms.catalog"],
      certify: ["POST", "/semantic-terms/certify", "semanticTerms.certify"],
      list: ["GET", "/semantic-terms", "semanticTerms.list"],
      query: ["POST", "/semantic-terms/query", "semanticTerms.query"],
      update: ["POST", "/semantic-terms/update", "semanticTerms.update"],
    });
    for (const procedure of Object.values(semanticTermsContract)) {
      expect(procedure["~orpc"].route.tags).toEqual(["Semantic terms"]);
    }
  });

  it("declares the error codes with their HTTP statuses", () => {
    expect(
      Object.fromEntries(
        Object.entries(SEMANTIC_TERMS_API_ERRORS).map(([code, value]) => [
          code,
          value.status,
        ])
      )
    ).toEqual({
      BAD_REQUEST: 400,
      CONFLICT: 409,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      STORAGE_ERROR: 503,
      UNAUTHORIZED: 401,
    });
  });

  it("accepts a term id with at most 10 scalar parameters", () => {
    expect(
      SemanticTermQueryInputSchema.parse({
        params: { days: 7, symbol: " SPY ", window: null },
        term: "pnl",
      })
    ).toEqual({
      params: { days: 7, symbol: "SPY", window: null },
      term: "pnl",
    });
    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`p${index}`, index])
    );
    for (const bad of [
      { params: eleven, term: "pnl" },
      { params: { days: Number.POSITIVE_INFINITY }, term: "pnl" },
      { params: { nested: { a: 1 } }, term: "pnl" },
      { term: "Net-Liq" },
      { sql: "select 1", term: "pnl" },
    ]) {
      expect(SemanticTermQueryInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("caps query output rows and limits cells to scalars", () => {
    const base = {
      answer: "ok",
      asOf: null,
      certified: true,
      groupings: [],
      label: "P&L",
      params: {},
      query: "pnl",
      rowCount: 0,
      rows: [],
      source: "feed",
      status: "ok",
      term: "pnl",
      truncated: false,
      unit: "USD",
    };
    expect(SemanticTermQueryOutputSchema.safeParse(base).success).toBe(true);
    const tooMany = Array.from({ length: SEMANTIC_QUERY_MAX_ROWS + 1 }, () => ({
      a: 1,
    }));
    for (const bad of [
      { ...base, rows: tooMany },
      { ...base, rows: [{ a: { b: 1 } }] },
      { ...base, status: "maybe" },
      {
        ...base,
        groupings: [
          {
            attribute: "a_sql",
            certified: true,
            grain: "per_symbol",
            rowCount: 0,
            status: "ok",
          },
        ],
      },
    ]) {
      expect(SemanticTermQueryOutputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("parses each catalog edit kind and refuses unknown fields", () => {
    expect(
      SemanticCatalogUpdateInputSchema.parse({
        id: "pnl",
        kind: "term",
        synonyms: [" profit "],
      })
    ).toEqual({ id: "pnl", kind: "term", synonyms: ["profit"] });
    expect(
      SemanticCatalogUpdateInputSchema.parse({
        id: "trades_sql",
        kind: "attribute",
        sql: "select 1",
      })
    ).toEqual({ id: "trades_sql", kind: "attribute", sql: "select 1" });
    for (const bad of [
      { id: "pnl", kind: "term", sql: "select 1" },
      { description: "   ", id: "rel", kind: "relationship" },
      { id: "pnl", kind: "metric" },
    ]) {
      expect(SemanticCatalogUpdateInputSchema.safeParse(bad).success).toBe(
        false
      );
    }
    const expectedUpdatedAt = "2026-11-08T12:00:00.000Z";
    expect(
      SemanticCatalogCertifyInputSchema.parse({
        certified: true,
        expectedUpdatedAt,
        id: "pnl",
        kind: "term",
        note: " checked ",
      })
    ).toEqual({
      certified: true,
      expectedUpdatedAt,
      id: "pnl",
      kind: "term",
      note: "checked",
    });
    for (const bad of [
      { certified: true, expectedUpdatedAt, id: "pnl", kind: "term" },
      { certified: true, id: "pnl", kind: "term", note: null },
      {
        certified: true,
        expectedUpdatedAt: "yesterday",
        id: "pnl",
        kind: "term",
        note: null,
      },
    ]) {
      expect(SemanticCatalogCertifyInputSchema.safeParse(bad).success).toBe(
        false
      );
    }
  });

  it("requires canWrite on the catalog output", () => {
    const empty = { attributes: [], relationships: [], terms: [] };
    expect(
      SemanticCatalogOutputSchema.safeParse({ ...empty, canWrite: false })
        .success
    ).toBe(true);
    expect(SemanticCatalogOutputSchema.safeParse(empty).success).toBe(false);
  });

  it("limits parameter specs to text and number", () => {
    expect(
      SemanticParamSpecSchema.safeParse({
        description: "Window",
        name: "window",
        options: ["daily"],
        required: false,
        type: "text",
      }).success
    ).toBe(true);
    expect(
      SemanticParamSpecSchema.safeParse({
        description: "When",
        name: "when",
        required: false,
        type: "date",
      }).success
    ).toBe(false);
  });
});
