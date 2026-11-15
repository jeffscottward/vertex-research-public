import {
  Table,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  cn,
} from "@darkfactory/ui";
import type { ComponentProps } from "react";

// Record tables in the experience destinations: roomy top-aligned cells that wrap long
// identities, the shared tinted header band and a rounded bordered region that scrolls
// horizontally.
const cell =
  "h-auto min-w-36 max-w-[25rem] whitespace-normal px-4 py-3 align-top [overflow-wrap:anywhere]";
const numeric = "whitespace-nowrap text-right";

export const experienceTableScroll =
  "w-full max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-border";

export const ExperienceTable = ({
  className,
  ...props
}: ComponentProps<typeof Table>) => (
  <Table
    className={cn("tabular-nums leading-relaxed", className)}
    containerClassName="overflow-visible"
    {...props}
  />
);

export const ExperienceTableCaption = ({
  className,
  ...props
}: ComponentProps<typeof TableCaption>) => (
  <TableCaption
    className={cn(
      "mt-0 caption-top py-4 text-left font-semibold text-foreground leading-relaxed",
      className
    )}
    {...props}
  />
);

export const ExperienceTableHeader = ({
  className,
  ...props
}: ComponentProps<typeof TableHeader>) => (
  <TableHeader className={cn("[&_th]:py-2", className)} {...props} />
);

interface CellOptions {
  readonly numeric?: boolean;
}

export const ExperienceTableHead = ({
  className,
  numeric: isNumeric = false,
  ...props
}: ComponentProps<typeof TableHead> & CellOptions) => (
  <TableHead
    className={cn(cell, isNumeric && numeric, className)}
    data-numeric={isNumeric ? "" : undefined}
    {...props}
  />
);

export const ExperienceTableCell = ({
  className,
  numeric: isNumeric = false,
  ...props
}: ComponentProps<typeof TableCell> & CellOptions) => (
  <TableCell
    className={cn(cell, isNumeric && numeric, className)}
    data-numeric={isNumeric ? "" : undefined}
    {...props}
  />
);
