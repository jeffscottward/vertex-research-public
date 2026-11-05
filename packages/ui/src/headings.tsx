import type { ComponentPropsWithRef, JSX, ReactNode } from "react";

import { cn } from "./utilities.ts";

interface PageHeaderBaseProps
  extends Omit<ComponentPropsWithRef<"header">, "title"> {
  actions?: ReactNode;
  title: ReactNode;
}

/**
 * Portal header (Fulcrum structure): optional breadcrumb above, the title with an optional status
 * chip, one plain line of purpose below, and the primary actions on the right.
 */
export interface PortalPageHeaderProps extends PageHeaderBaseProps {
  breadcrumb?: ReactNode;
  description?: ReactNode;
  eyebrow?: never;
  status?: ReactNode;
  variant?: "portal";
}

export interface PublicPageHeaderProps extends PageHeaderBaseProps {
  breadcrumb?: never;
  description?: ReactNode;
  eyebrow?: ReactNode;
  status?: never;
  variant: "public";
}

export type PageHeaderProps = PortalPageHeaderProps | PublicPageHeaderProps;

export const PageHeader = ({
  actions,
  breadcrumb,
  className,
  description,
  eyebrow,
  status,
  title,
  variant = "portal",
  ...props
}: PageHeaderProps) => {
  const heading = (
    <h1
      className={cn(
        "tracking-tight",
        variant === "public" ? "font-extrabold text-4xl" : "font-bold text-2xl"
      )}
    >
      {title}
    </h1>
  );
  return (
    <header
      {...props}
      className={cn(
        variant === "public"
          ? "grid gap-4 border-border border-b pb-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
          : "flex flex-wrap items-center justify-between gap-2",
        className
      )}
      data-variant={variant}
    >
      <div className={cn("min-w-0", variant === "public" && "space-y-3")}>
        {breadcrumb === undefined ? null : (
          <div
            className="mb-1 min-w-0 truncate text-muted-foreground text-sm"
            data-slot="page-breadcrumb"
          >
            {breadcrumb}
          </div>
        )}
        {eyebrow === undefined ? null : (
          <p className="font-medium text-muted-foreground text-sm">{eyebrow}</p>
        )}
        {status === undefined ? (
          heading
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {heading}
            <span className="inline-flex" data-slot="page-status">
              {status}
            </span>
          </div>
        )}
        {description === undefined ? null : (
          <p
            className={cn(
              "max-w-reading text-muted-foreground",
              variant === "portal" && "mt-1 text-sm"
            )}
          >
            {description}
          </p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {actions}
        </div>
      )}
    </header>
  );
};

export type SectionHeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface SectionHeaderProps
  extends Omit<ComponentPropsWithRef<"div">, "title"> {
  actions?: ReactNode;
  headingLevel?: SectionHeadingLevel;
  title: ReactNode;
}

export const SectionHeader = ({
  actions,
  className,
  headingLevel = 2,
  title,
  ...props
}: SectionHeaderProps) => {
  const Heading = `h${headingLevel}` as keyof Pick<
    JSX.IntrinsicElements,
    "h2" | "h3" | "h4" | "h5" | "h6"
  >;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className
      )}
      {...props}
    >
      <Heading className="min-w-0 font-medium text-lg">{title}</Heading>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      )}
    </div>
  );
};
