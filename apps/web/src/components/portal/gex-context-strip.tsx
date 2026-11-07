import type { GexContext, GexContextFactor } from "@darkfactory/api";
import { cn } from "@darkfactory/ui";
import { useId } from "react";

// "Read this before trusting the number": one chip per GEX caveat (dealer sign, freshness,
// expiry mix, regime, flow, levels, other dealer Greeks, IV regime, events), shown next to
// the estimated GEX. The same `context` object reaches research agents through MCP.

const TONE_CLASS: Readonly<Record<GexContextFactor["tone"], string>> = {
  alert: "border-destructive-border bg-destructive-subtle",
  caution: "border-warning-border bg-warning-subtle",
  neutral: "border-border",
};

const TONE_TEXT: Readonly<Record<GexContextFactor["tone"], string>> = {
  alert: "Check",
  caution: "Caution",
  neutral: "Info",
};

export const GexContextStrip = ({
  context,
}: {
  readonly context: GexContext;
}) => {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-2"
      data-gex-context=""
      data-gex-regime={context.regime}
    >
      <h4 className="font-medium text-xs" id={id}>
        Read this before trusting the number
      </h4>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {context.factors.map((factor) => (
          <li
            aria-describedby={`${id}-${factor.key}`}
            className={cn(
              "min-w-0 rounded-md border px-2.5 py-1.5 text-xs",
              TONE_CLASS[factor.tone]
            )}
            data-factor={factor.key}
            data-tone={factor.tone}
            key={factor.key}
          >
            <p className="text-muted-foreground">
              <span className="sr-only">{TONE_TEXT[factor.tone]}: </span>
              {factor.label}
            </p>
            <p className="break-words font-medium">{factor.value}</p>
          </li>
        ))}
      </ul>
      <details className="text-xs">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted-foreground">
          What each badge means
        </summary>
        <dl className="space-y-1.5 pt-1" data-gex-context-details="">
          {context.factors.map((factor) => (
            <div key={factor.key}>
              <dt className="font-medium">{factor.label}</dt>
              <dd className="text-muted-foreground" id={`${id}-${factor.key}`}>
                {factor.detail}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
};
