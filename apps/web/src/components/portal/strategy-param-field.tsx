"use client";

import type { StrategyParamOutput } from "@darkfactory/api";
import { Input } from "@darkfactory/ui";

// One typed strategy parameter input (integer, decimal, boolean or choice). Shared by the strategy
// library preset form and the paper deployment request form; idPrefix keeps ids unique per form.

export const selectClass =
  "h-11 w-full rounded-sm border border-border-strong bg-surface px-2 text-sm";

export const ParamField = ({
  param,
  value,
  onChange,
  idPrefix = "preset-param",
}: {
  readonly param: StrategyParamOutput;
  readonly value: string | boolean | undefined;
  readonly onChange: (value: string | boolean) => void;
  readonly idPrefix?: string;
}) => {
  const id = `${idPrefix}-${param.name}`;
  if (param.type === "boolean") {
    return (
      <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor={id}>
        <input
          checked={value === true}
          className="size-5"
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {param.title}
        <span className="font-mono text-muted-foreground text-xs">
          {param.name}
        </span>
      </label>
    );
  }
  if (param.type === "choice") {
    return (
      <label className="text-xs" htmlFor={id}>
        {param.title}{" "}
        <span className="font-mono text-muted-foreground">{param.name}</span>
        <select
          className={selectClass}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={typeof value === "string" ? value : ""}
        >
          {(param.options ?? []).map((option) => {
            return (
              <option key={option} value={option}>
                {option}
              </option>
            );
          })}
        </select>
      </label>
    );
  }
  return (
    <label className="text-xs" htmlFor={id}>
      {param.title}{" "}
      <span className="font-mono text-muted-foreground">{param.name}</span>
      <Input
        id={id}
        inputMode={param.type === "integer" ? "numeric" : "decimal"}
        max={param.max}
        min={param.min}
        onChange={(event) => onChange(event.target.value)}
        step={param.step ?? (param.type === "integer" ? 1 : "any")}
        type="number"
        value={typeof value === "string" ? value : ""}
      />
    </label>
  );
};
