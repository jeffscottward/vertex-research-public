export const CANONICAL_APP_URL = "https://darkfactory.localhost" as const;

export type AppEnvironment = "development" | "test" | "production";

export type ClientEnvironmentSource = Readonly<{
  APP_ENV: AppEnvironment;
  APP_URL: string;
  APP_NAME: string;
}>;

export type ClientEnv = ClientEnvironmentSource;

export const toClientEnv = (env: ClientEnvironmentSource): ClientEnv => ({
  APP_ENV: env.APP_ENV,
  APP_URL: env.APP_URL,
  APP_NAME: env.APP_NAME,
});

// The single exception to the HTTPS-only app origin rule: a portless plain-HTTP
// *.localhost origin, only when APP_ENV is "development". Browsers treat
// *.localhost as a secure context and resolve it to loopback. Test and
// production environments always require HTTPS.
export const isDevelopmentLocalhostHttpOrigin = (
  value: string | URL,
  appEnvironment: string | undefined
): boolean => {
  if (appEnvironment !== "development") return false;
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname.endsWith(".localhost") &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
};
