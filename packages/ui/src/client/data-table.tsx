// What: shared sortable DataTable. Every column header is a real 44px button; click sorts asc, click again toggles asc/desc; shows a sort arrow and sets aria-sort. Numbers, dates, currency and percents sort numerically, text case-insensitively, empties always last. Wrapped in overflow-x-auto; optional line-clamp-2 cells.
// Used by: apps/web/src/features/experience/agents.tsx and other migrated tables.
// See: packages/ui/src/data-table-sort.ts; packages/ui/src/table.tsx.
"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useState } from "react";

import {
  compareSortValues,
  type SortDirection,
  type SortValue,
} from "../data-table-sort.ts";
import {
  Table,
  type TableProps,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table.tsx";
import { cn } from "../utilities.ts";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  /** Raw value used for sorting (and rendering when `cell` is absent). Only data-less columns (row actions) omit it, which makes them unsortable. */
  value?: (row: Row) => SortValue;
  cell?: (row: Row) => ReactNode;
  /** Clamp long text to two lines. */
  clamp?: boolean;
  align?: "left" | "right";
  /** Render body cells as row headers (`<th scope="row">`). */
  rowHeader?: boolean;
}

export interface DataTableSort {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  caption?: ReactNode;
  initialSort?: DataTableSort;
  className?: string;
  containerClassName?: string;
  containerProps?: TableProps["containerProps"];
  rowProps?: (
    row: Row
  ) => HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export const sortRows = <Row,>(
  rows: readonly Row[],
  columns: readonly DataTableColumn<Row>[],
  sort: DataTableSort | undefined
): Row[] => {
  const value = columns.find(
    (candidate) => candidate.id === sort?.columnId
  )?.value;
  if (!(sort && value)) return [...rows];
  return [...rows].sort((left, right) =>
    compareSortValues(value(left), value(right), sort.direction)
  );
};

const ariaSort = (
  sort: DataTableSort | undefined,
  columnId: string
): "ascending" | "descending" | "none" => {
  if (sort?.columnId !== columnId) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
};

const SortIcon = ({
  state,
}: {
  state: "ascending" | "descending" | "none";
}) => {
  if (state === "ascending")
    return <ArrowUp aria-hidden className="size-3.5" />;
  if (state === "descending")
    return <ArrowDown aria-hidden className="size-3.5" />;
  return <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />;
};

export const DataTable = <Row,>({
  columns,
  rows,
  rowKey,
  caption,
  initialSort,
  className,
  containerClassName,
  containerProps,
  rowProps,
  ...labelProps
}: DataTableProps<Row>) => {
  const [sort, setSort] = useState<DataTableSort | undefined>(initialSort);
  const sorted = sortRows(rows, columns, sort);
  const toggle = (columnId: string) =>
    setSort((current) =>
      current?.columnId === columnId && current.direction === "asc"
        ? { columnId, direction: "desc" }
        : { columnId, direction: "asc" }
    );

  return (
    <Table
      className={className}
      containerClassName={containerClassName}
      containerProps={containerProps}
      data-slot="data-table"
      {...labelProps}
    >
      {caption ? <TableCaption>{caption}</TableCaption> : null}
      <TableHeader>
        <TableRow>
          {columns.map((column) => {
            if (column.value === undefined) {
              return (
                <TableHead key={column.id} scope="col">
                  {column.header}
                </TableHead>
              );
            }
            const state = ariaSort(sort, column.id);
            return (
              <TableHead aria-sort={state} key={column.id} scope="col">
                <button
                  className={cn(
                    "-mx-2 inline-flex min-h-11 min-w-11 items-center gap-1 rounded-md px-2 font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    column.align === "right" && "w-full justify-end"
                  )}
                  onClick={() => toggle(column.id)}
                  type="button"
                >
                  {column.header}
                  <SortIcon state={state} />
                </button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row, index) => (
          <TableRow key={rowKey(row, index)} {...rowProps?.(row)}>
            {columns.map((column) => {
              const content = column.cell
                ? column.cell(row)
                : (column.value?.(row) as ReactNode);
              const cellClass = cn(
                column.align === "right" && "text-right tabular-nums",
                column.clamp && "min-w-48 whitespace-normal"
              );
              const body = column.clamp ? (
                <span className="line-clamp-2">{content}</span>
              ) : (
                content
              );
              return column.rowHeader ? (
                <TableHead
                  className={cn("font-medium", cellClass)}
                  key={column.id}
                  scope="row"
                >
                  {body}
                </TableHead>
              ) : (
                <TableCell className={cellClass} key={column.id}>
                  {body}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
