// What: shadcn/ui new-york-v4 Alert styles (default and destructive) as class helpers, so a notice
// keeps its own element and role (a <section> with a heading, or a status <div>).
// Used by: apps/web read-state notices (audit phase 3 replaced the vx-read-notice classes).
// See: https://ui.shadcn.com/docs/components/alert.
import { cva } from "class-variance-authority";

export const alertVariants = cva(
  "relative grid w-full gap-1 rounded-lg border px-4 py-3 text-sm [&>p:not(.alert-title)]:text-muted-foreground",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-destructive-border bg-card text-destructive [&>p:not(.alert-title)]:text-destructive/90",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

/** Title line inside an alert; `alert-title` keeps it out of the muted description rule. */
export const alertTitleClassName =
  "alert-title font-medium leading-snug tracking-tight";
