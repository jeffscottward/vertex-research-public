// What: UI lab query-param parsing (?theme=, ?symbol=, enum choices). Bad values fall back to defaults.
// Used by: apps/web/src/app/lab/**, apps/web/src/lab/lab-views.tsx, apps/web/src/lab/entries/*.

export type LabTheme = "dark" | "light";

/** The lab frame's data-theme value for each ?theme= choice (dark by default). */
export const LAB_THEME_ATTRIBUTE: Readonly<Record<LabTheme, string>> =
  Object.freeze({ dark: "default-dark", light: "default-light" });

export type LabSearchParamsRecord = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** Next.js page searchParams -> URLSearchParams (repeated keys keep every value). */
export const toLabSearchParams = (
  record: LabSearchParamsRecord
): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value)
      params.append(name, item);
  }
  return params;
};

/** The first value of a param from an allowed list, else the fallback. */
export const readLabChoice = <Choice extends string>(
  params: URLSearchParams,
  name: string,
  choices: readonly Choice[],
  fallback: Choice
): Choice => {
  const value = params.get(name)?.trim();
  return choices.find((choice) => choice === value) ?? fallback;
};

export const readLabTheme = (params: URLSearchParams): LabTheme =>
  readLabChoice(params, "theme", ["dark", "light"], "dark");

const SYMBOL = /^[A-Z][A-Z0-9.]{0,11}$/u;

/** ?symbol= upper-cased; invalid or absent values use the fallback. */
export const readLabSymbol = (
  params: URLSearchParams,
  fallback: string,
  name = "symbol"
): string => {
  const value = params.get(name)?.trim().toUpperCase() ?? "";
  return SYMBOL.test(value) ? value : fallback;
};

/** A lab entry's href with the current params kept, e.g. to switch only ?theme=. */
export const withLabParam = (
  path: string,
  params: URLSearchParams,
  name: string,
  value: string
): string => {
  const next = new URLSearchParams(params);
  next.set(name, value);
  return `${path}?${next.toString()}`;
};
