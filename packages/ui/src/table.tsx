// What: shadcn/ui new-york-v4 Table primitives: Table (with overflow-x-auto container), TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption.
// Used by: packages/ui/src/index.ts; packages/ui/src/client/data-table.tsx.
// See: https://ui.shadcn.com/docs/components/table.
import type { ComponentPropsWithRef } from "react";

import { cn } from "./utilities.ts";

export interface TableProps extends ComponentPropsWithRef<"table"> {
  containerClassName?: string | undefined;
  /** Extra attributes for the scroll container, e.g. a focusable labelled region. */
  containerProps?: Omit<ComponentPropsWithRef<"div">, "className"> | undefined;
}

export const Table = ({
  className,
  containerClassName,
  containerProps,
  ...props
}: TableProps) => (
  <div
    {...containerProps}
    className={cn("relative w-full overflow-x-auto", containerClassName)}
    data-slot="table-container"
  >
    <table
      className={cn("w-full caption-bottom text-sm", className)}
      data-slot="table"
      {...props}
    />
  </div>
);

export const TableHeader = ({
  className,
  ...props
}: ComponentPropsWithRef<"thead">) => (
  <thead
    className={cn("[&_tr]:border-b", className)}
    data-slot="table-header"
    {...props}
  />
);

export const TableBody = ({
  className,
  ...props
}: ComponentPropsWithRef<"tbody">) => (
  <tbody
    className={cn("[&_tr:last-child]:border-0", className)}
    data-slot="table-body"
    {...props}
  />
);

export const TableFooter = ({
  className,
  ...props
}: ComponentPropsWithRef<"tfoot">) => (
  <tfoot
    className={cn(
      "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
      className
    )}
    data-slot="table-footer"
    {...props}
  />
);

export const TableRow = ({
  className,
  ...props
}: ComponentPropsWithRef<"tr">) => (
  <tr
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className
    )}
    data-slot="table-row"
    {...props}
  />
);

export const TableHead = ({
  className,
  ...props
}: ComponentPropsWithRef<"th">) => (
  <th
    className={cn(
      "h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-foreground",
      className
    )}
    data-slot="table-head"
    {...props}
  />
);

export const TableCell = ({
  className,
  ...props
}: ComponentPropsWithRef<"td">) => (
  <td
    className={cn("whitespace-nowrap p-2 align-middle", className)}
    data-slot="table-cell"
    {...props}
  />
);

export const TableCaption = ({
  className,
  ...props
}: ComponentPropsWithRef<"caption">) => (
  <caption
    className={cn("mt-4 text-muted-foreground text-sm", className)}
    data-slot="table-caption"
    {...props}
  />
);
