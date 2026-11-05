// What: Panel, a bordered content section with a header bar (title, optional description and actions) and a body. `flush` removes the body padding so a Table sits edge to edge, with its first and last columns aligned to the header text.
// Used by: packages/ui/src/index.ts; apps/web portal pages (engines, watchlist, portfolio, mission control).
// See: packages/ui/src/card.tsx (free-form cards); packages/ui/src/table.tsx; design-system/darkfactory/MASTER.md.
import type { ComponentPropsWithRef, JSX, ReactNode } from "react";

import { cn } from "./utilities.ts";

export type PanelHeadingLevel = 2 | 3 | 4;

export interface PanelProps
  extends Omit<ComponentPropsWithRef<"section">, "title"> {
  actions?: ReactNode;
  /** Classes for the body wrapper. */
  contentClassName?: string;
  description?: ReactNode;
  /** No body padding: for a Table or a list that draws its own row separators. */
  flush?: boolean;
  /** Id for the heading; the section is then a named region (aria-labelledby). */
  headingId?: string;
  headingLevel?: PanelHeadingLevel;
  title: ReactNode;
}

/** Flush body: the outer table columns line up with the 1rem header inset. */
const FLUSH_TABLE_INSET =
  "[&_[data-slot=table]_th:first-child]:pl-4 [&_[data-slot=table]_td:first-child]:pl-4 [&_[data-slot=table]_th:last-child]:pr-4 [&_[data-slot=table]_td:last-child]:pr-4";

export const Panel = ({
  actions,
  children,
  className,
  contentClassName,
  description,
  flush = false,
  headingId,
  headingLevel = 2,
  title,
  ...props
}: PanelProps) => {
  const Heading = `h${headingLevel}` as keyof Pick<
    JSX.IntrinsicElements,
    "h2" | "h3" | "h4"
  >;
  return (
    <section
      {...(headingId === undefined ? {} : { "aria-labelledby": headingId })}
      {...props}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs",
        className
      )}
      data-slot="panel"
    >
      <header
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3"
        data-slot="panel-header"
      >
        <div className="min-w-0 space-y-0.5">
          <Heading
            className="font-semibold text-base leading-snug"
            {...(headingId === undefined ? {} : { id: headingId })}
          >
            {title}
          </Heading>
          {description === undefined ? null : (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </header>
      <div
        className={cn(flush ? FLUSH_TABLE_INSET : "p-4", contentClassName)}
        data-slot="panel-content"
      >
        {children}
      </div>
    </section>
  );
};
