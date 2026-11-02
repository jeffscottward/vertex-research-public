import { cn } from "@darkfactory/ui";
import type { ComponentPropsWithRef } from "react";

/** Vertex Research logo (public/vertex-logo.svg); decorative next to the visible wordmark. */
export const BrandMark = ({
  className,
  ...props
}: ComponentPropsWithRef<"img">) => (
  <img
    {...props}
    alt=""
    aria-hidden="true"
    className={cn("vx-brand-mark shrink-0", className)}
    height={40}
    src="/vertex-logo.svg"
    width={40}
  />
);

export const BrandLink = ({ className }: { readonly className?: string }) => (
  <a
    aria-label="Vertex Research home"
    className={cn(
      "vx-brand-link rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
      className
    )}
    href="/"
  >
    <BrandMark />
    <span className="vx-wordmark">
      Vertex<span>Research</span>
    </span>
  </a>
);
