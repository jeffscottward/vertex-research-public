// What: which Vertex site the shell wraps and where its windows may navigate. The site origin comes
// from --url=<origin>, then VERTEX_DESKTOP_URL, then the saved settings; the repo ships no host.
// Only https origins load, plus http on loopback for local development.
// Used by: app.ts (startup) and electron-ports.ts (navigation and window-open guards).

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** The origin of `raw` when it is an allowed site URL, else null. Paths and queries are dropped. */
export const parseSiteOrigin = (raw: string | undefined): string | null => {
  if (raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const loopback =
    LOOPBACK_HOSTS.includes(url.hostname) ||
    url.hostname.endsWith(".localhost");
  if (url.protocol === "http:" && loopback) return url.origin;
  if (url.protocol === "https:") return url.origin;
  return null;
};

export type SiteUrlSources = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  saved: string | undefined;
}>;

const URL_FLAG = "--url=";

/** First valid origin from the command line, the environment or the saved settings. */
export const resolveSiteOrigin = (sources: SiteUrlSources): string | null => {
  const flag = sources.argv.find((arg) => arg.startsWith(URL_FLAG));
  const candidates = [
    flag?.slice(URL_FLAG.length),
    sources.env["VERTEX_DESKTOP_URL"],
    sources.saved,
  ];
  for (const candidate of candidates) {
    const origin = parseSiteOrigin(candidate);
    if (origin !== null) return origin;
  }
  return null;
};

export type NavigationTarget = "inside" | "external" | "blocked";

/** inside: same origin as the site; external: another http(s) page (system browser); else blocked. */
export const classifyNavigation = (
  siteOrigin: string,
  raw: string
): NavigationTarget => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "blocked";
  }
  if (url.origin === siteOrigin) return "inside";
  return url.protocol === "https:" || url.protocol === "http:"
    ? "external"
    : "blocked";
};
