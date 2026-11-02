// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../table.tsx";
import { DataTable, type DataTableColumn, sortRows } from "./data-table.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Row {
  name: string;
  pct: string;
  note: string;
}

const rows: Row[] = [
  { name: "beta", pct: "12.5%", note: "long text" },
  { name: "Alpha", pct: "", note: "x" },
  { name: "gamma", pct: "2%", note: "y" },
];

const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", value: (row) => row.name, rowHeader: true },
  {
    id: "pct",
    header: "Return",
    value: (row) => row.pct,
    align: "right",
    cell: (row) => <b>{row.pct || "—"}</b>,
  },
  { id: "note", header: "Note", value: (row) => row.note, clamp: true },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    cell: (row) => <button type="button">Open {row.name}</button>,
  },
  { id: "blank", header: "Blank" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const names = () =>
  [...container.querySelectorAll("tbody th")].map((cell) => cell.textContent);

describe("Table primitives", () => {
  it("wrap the table in a horizontal scroll container with shadcn slots", () => {
    const html = renderToStaticMarkup(
      <Table containerClassName="extra" containerProps={{ id: "c" }}>
        <TableCaption>Cap</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>H</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>C</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>F</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );
    expect(html).toMatch(
      /^<div id="c" class="relative w-full overflow-x-auto extra"/
    );
    for (const slot of [
      "table",
      "table-caption",
      "table-header",
      "table-body",
      "table-footer",
      "table-row",
      "table-head",
      "table-cell",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    return expect(html).toContain("<caption");
  });
});

describe("DataTable", () => {
  it("renders 44px header buttons, aria-sort none and clamped cells", () => {
    act(() =>
      root.render(
        <DataTable
          aria-label="Runs"
          caption="Runs table"
          columns={columns}
          containerProps={{ role: "region", "aria-label": "Runs scroll" }}
          rowProps={(row) => ({ "data-name": row.name })}
          rowKey={(row) => row.name}
          rows={rows}
        />
      )
    );
    const buttons = container.querySelectorAll("thead button");
    expect(buttons).toHaveLength(3);
    expect(
      container.querySelectorAll("thead th")[3]?.hasAttribute("aria-sort")
    ).toBe(false);
    expect(
      container.querySelector('[role="region"]')?.getAttribute("aria-label")
    ).toBe("Runs scroll");
    expect(container.querySelector('tr[data-name="gamma"]')).not.toBeNull();
    expect(buttons[0]?.className).toContain("min-h-11");
    expect(buttons[0]?.getAttribute("type")).toBe("button");
    expect(
      container.querySelector("th[aria-sort]")?.getAttribute("aria-sort")
    ).toBe("none");
    expect(container.querySelector(".line-clamp-2")?.textContent).toBe(
      "long text"
    );
    expect(container.querySelector("table")?.getAttribute("aria-label")).toBe(
      "Runs"
    );
    expect(container.querySelector("caption")?.textContent).toBe("Runs table");
    return expect(names()).toEqual(["beta", "Alpha", "gamma"]);
  });

  it("toggles asc then desc on click and keeps empties last", () => {
    act(() =>
      root.render(
        <DataTable columns={columns} rowKey={(row) => row.name} rows={rows} />
      )
    );
    const headers = container.querySelectorAll("thead th");
    const pctButton = headers[1]?.querySelector("button") as HTMLButtonElement;
    act(() => pctButton.click());
    expect(headers[1]?.getAttribute("aria-sort")).toBe("ascending");
    expect(names()).toEqual(["gamma", "beta", "Alpha"]);
    act(() => pctButton.click());
    expect(headers[1]?.getAttribute("aria-sort")).toBe("descending");
    expect(names()).toEqual(["beta", "gamma", "Alpha"]);
    act(() => pctButton.click());
    expect(headers[1]?.getAttribute("aria-sort")).toBe("ascending");
    const nameButton = headers[0]?.querySelector("button") as HTMLButtonElement;
    act(() => nameButton.click());
    expect(headers[1]?.getAttribute("aria-sort")).toBe("none");
    return expect(names()).toEqual(["Alpha", "beta", "gamma"]);
  });

  return it("honours initialSort and ignores unknown sort columns", () => {
    const html = renderToStaticMarkup(
      <DataTable
        columns={columns}
        initialSort={{ columnId: "name", direction: "desc" }}
        rowKey={(row) => row.name}
        rows={rows}
      />
    );
    expect(html).toContain('aria-sort="descending"');
    expect(html.indexOf("gamma")).toBeLessThan(html.indexOf("Alpha"));
    expect(
      sortRows(rows, columns, { columnId: "missing", direction: "asc" })
    ).toEqual(rows);
    return expect(
      sortRows(rows, columns, { columnId: "actions", direction: "asc" })
    ).toEqual(rows);
  });
});
