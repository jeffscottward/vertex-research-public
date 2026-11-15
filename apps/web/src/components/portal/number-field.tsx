"use client";

import { useId } from "react";

/** Labelled number input with a 44 px target, shared by the backtest run and sweep forms. */
export const NumberField = ({
  disabled = false,
  label,
  value,
  onChange,
  step = 1,
}: Readonly<{
  disabled?: boolean;
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}>) => {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label className="font-medium text-sm" htmlFor={id}>
        {label}
      </label>
      <input
        className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm disabled:opacity-60"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </div>
  );
};
