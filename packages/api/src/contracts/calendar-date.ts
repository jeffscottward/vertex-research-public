import { z } from "zod";

// A UTC calendar date written as YYYY-MM-DD. Shared by the backtest run and sweep contracts.

export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected YYYY-MM-DD")
  .refine(
    (value) => {
      // Invalid dates (month 13, day 32) make toISOString throw, so check the time first.
      const date = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
      );
    },
    { message: "Not a valid calendar date" }
  );
