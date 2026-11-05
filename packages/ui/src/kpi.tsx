// What: KpiRow and KpiCard, the page-level summary strip: 2-4 bordered cards, each with an icon and label, one large number and one plain sub-line. The row stacks on mobile.
// Used by: packages/ui/src/index.ts; apps/web portal pages (todos, watchlist).
// See: packages/ui/src/stat-card.tsx (older single stat); design-system/darkfactory/MASTER.md.
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "./utilities.ts";

export interface KpiRowProps extends ComponentPropsWithRef<"div"> {
  /** Label for the group, read by screen readers. */
  label?: string;
}

/** One column on mobile, two from sm, up to four from lg (driven by the number of cards). */
export const KpiRow = ({ className, label, ...props }: KpiRowProps) => (
  <div
    {...(label === undefined ? {} : { "aria-label": label })}
    className={cn(
      "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none",
      className
    )}
    data-slot="kpi-row"
    role="group"
    {...props}
  />
);

export interface KpiCardProps
  extends Omit<ComponentPropsWithRef<"dl">, "title"> {
  hint?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
  value: ReactNode;
}

export const KpiCard = ({
  className,
  hint,
  icon,
  label,
  value,
  ...props
}: KpiCardProps) => (
  <dl
    className={cn(
      "flex min-w-0 flex-col gap-2 rounded-xl border bg-card px-4 py-4 text-card-foreground shadow-xs",
      className
    )}
    data-slot="kpi-card"
    {...props}
  >
    <dt className="flex items-center gap-2 text-muted-foreground text-sm">
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className="inline-flex size-4 shrink-0 [&_svg]:size-4"
          data-slot="kpi-icon"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
    </dt>
    <dd className="font-semibold text-2xl tabular-nums leading-tight">
      {value}
    </dd>
    {hint === undefined ? null : (
      <dd className="text-muted-foreground text-xs">{hint}</dd>
    )}
  </dl>
);
