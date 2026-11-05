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
      className={cn("w-full caption-bottom text-sm tabular-nums", className)}
      data-slot="table"
      {...props}
    />
  </div>
);

export const TableHeader = ({
  className,
  ...props
}: ComponentPropsWithRef<"thead">) => (
  // Reference look: a tinted header row with small uppercase muted labels; row headers in the body keep body text.
  <thead
    className={cn(
      "bg-muted/50 [&_th]:h-9 [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wide [&_tr]:border-b [&_tr]:hover:bg-transparent",
      className
    )}
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

export interface TableHeadProps extends ComponentPropsWithRef<"th"> {
  /** Number column: right-aligned label to match right-aligned figures. */
  numeric?: boolean;
}

export const TableHead = ({
  className,
  numeric = false,
  ...props
}: TableHeadProps) => (
  <th
    className={cn(
      "h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-foreground",
      numeric && "text-right",
      className
    )}
    data-slot="table-head"
    {...props}
  />
);

export interface TableCellProps extends ComponentPropsWithRef<"td"> {
  /** Number cell: right-aligned tabular figures. */
  numeric?: boolean;
}

export const TableCell = ({
  className,
  numeric = false,
  ...props
}: TableCellProps) => (
  <td
    className={cn(
      "whitespace-nowrap px-3 py-2.5 align-middle",
      numeric && "text-right tabular-nums",
      className
    )}
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

export interface TableScrollTextProps
  extends Omit<ComponentPropsWithRef<"span">, "children" | "title"> {
  /** The full text; also the tooltip, so a cut-off name stays readable. */
  text: string;
}

/**
 * Narrow cell text for identifier columns (symbols): a fixed width of about 7 characters.
 * Touch users pan it sideways with a finger (touch-action: pan-x). Longer
 * text, such as an option contract name with expiry and strike, scrolls inside the cell instead of
 * widening the column and squashing the other columns. Keyboard users can focus it to scroll.
 */
export const TableScrollText = ({
  className,
  text,
  ...props
}: TableScrollTextProps) => (
  <span
    className={cn(
      "block w-[7ch] overflow-x-auto overscroll-x-contain whitespace-nowrap py-1 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      className
    )}
    data-slot="table-scroll-text"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll a long name.
    tabIndex={0}
    title={text}
    {...props}
  >
    {text}
  </span>
);

export interface TableScrollProps extends ComponentPropsWithRef<"div"> {
  /** Accessible name for the scroll region (keyboard users focus it to scroll). */
  label: string;
  /** Minimum table width before the region scrolls, as a CSS length. Default 40rem. */
  minWidth?: string;
}

/**
 * Mobile wrapper for a wide table: below the table's minimum width the region scrolls
 * horizontally, so columns keep a readable width (never one character per line).
 */
export const TableScroll = ({
  children,
  className,
  label,
  minWidth = "40rem",
  style,
  ...props
}: TableScrollProps) => (
  <div
    aria-label={label}
    className={cn(
      "relative w-full overflow-x-auto [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_[data-slot=table-container]]:overflow-visible [&_[data-slot=table]]:min-w-(--table-min-width)",
      className
    )}
    data-slot="table-scroll"
    role="region"
    style={{ ...style, ["--table-min-width" as string]: minWidth }}
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to scroll a wide table.
    tabIndex={0}
    {...props}
  >
    {children}
  </div>
);
