import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";

import { cn } from "./utilities.ts";

// The plain look has two triggers: the `plain` prop, and an ancestor with data-slot="page-status"
// (the status slot of PageHeader). It removes only the shape: border, fill, dot, rounded box and
// padding. Text colour: warning and destructive keep their colour, so a problem stays visible;
// neutral, info and success print muted. Keep the two definitions below in step.
// `relative` keeps the sr-only "Status:" prefix (position: absolute) inside the badge. Without it
// the prefix escaped a table scroll container and made the page wider than a phone screen.

// Trigger 1, the status slot of PageHeader: the default look with its shape removed.
const PLAIN_IN_PAGE_STATUS =
  "in-data-[slot=page-status]:rounded-none in-data-[slot=page-status]:border-0 in-data-[slot=page-status]:bg-transparent in-data-[slot=page-status]:p-0 in-data-[slot=page-status]:before:hidden";
const MUTED_IN_PAGE_STATUS = "in-data-[slot=page-status]:text-muted-foreground";

export const statusBadgeVariants = cva(
  [
    "relative inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-xs before:size-1.5 before:shrink-0 before:rounded-full before:bg-current",
    PLAIN_IN_PAGE_STATUS,
  ],
  {
    variants: {
      status: {
        neutral: ["border-border text-foreground", MUTED_IN_PAGE_STATUS],
        success: [
          "border-success-border bg-success-subtle text-success-foreground",
          MUTED_IN_PAGE_STATUS,
        ],
        warning:
          "border-warning-border bg-warning-subtle text-warning-foreground",
        info: [
          "border-info-border bg-info-subtle text-info-foreground",
          MUTED_IN_PAGE_STATUS,
        ],
        destructive:
          "border-destructive-border bg-destructive-subtle text-destructive",
      },
    },
    defaultVariants: { status: "neutral" },
  }
);

// Trigger 2, the `plain` prop: the same text with no shape classes at all.
const plainStatusBadgeVariants = cva(
  "relative inline-flex w-fit shrink-0 items-center whitespace-nowrap font-medium text-xs",
  {
    variants: {
      status: {
        neutral: "text-muted-foreground",
        success: "text-muted-foreground",
        warning: "text-warning-foreground",
        info: "text-muted-foreground",
        destructive: "text-destructive",
      },
    },
  }
);

export interface StatusBadgeProps
  extends ComponentPropsWithRef<"span">,
    VariantProps<typeof statusBadgeVariants> {
  /**
   * Prints the status as plain text: no border, fill, dot, rounded box or padding. Warning and
   * destructive keep their text colour; the other statuses print muted.
   */
  plain?: boolean;
  status: NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>;
}

export const StatusBadge = ({
  children,
  className,
  plain = false,
  status,
  ...props
}: StatusBadgeProps) => (
  <span
    className={cn(
      plain
        ? plainStatusBadgeVariants({ status })
        : statusBadgeVariants({ status }),
      className
    )}
    data-plain={plain ? "true" : undefined}
    data-slot="badge"
    data-status={status}
    {...props}
  >
    <span className="sr-only">Status:</span>
    <span>{children}</span>
  </span>
);
