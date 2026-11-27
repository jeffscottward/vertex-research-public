import type { ReactNode } from "react";
import { IconButton } from "@darkfactory/ui";
import { Info } from "lucide-react";
import "./research-table-heading.css";

export const ResearchTableHeading = ({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  /** Help text for the info popover. Without it the heading has no info button. */
  readonly children?: ReactNode;
}) => (
  <div className="vx-research-table-heading">
    <h2 id={id}>{title}</h2>
    {children === undefined ? null : (
      <>
        <IconButton
          aria-label={`About ${title}`}
          title={`About ${title}`}
          type="button"
          popoverTarget={`${id}-help`}
          popoverTargetAction="toggle"
          variant="ghost"
        >
          <Info aria-hidden="true" />
        </IconButton>
        <aside
          id={`${id}-help`}
          popover="auto"
          aria-labelledby={id}
          role="note"
          className="vx-research-table-help"
        >
          {children}
        </aside>
      </>
    )}
  </div>
);
