// "14:02 UTC" for status texts (owner rule 2026-11-11: name since when). Unparsable input: "time not recorded".
export const utcClock = (at: Date | string | number): string => {
  const ms =
    at instanceof Date
      ? at.getTime()
      : typeof at === "number"
        ? at
        : Date.parse(at);
  if (!Number.isFinite(ms)) return "time not recorded";
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
};
