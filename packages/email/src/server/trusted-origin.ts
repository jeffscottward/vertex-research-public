// Mirrors isDevelopmentLocalhostHttpOrigin in @darkfactory/config; this package
// does not depend on the config package. A plain-HTTP app origin is trusted only
// for a portless *.localhost name and only when the app environment is
// "development". Test and production links always require HTTPS.
export const isDevelopmentLocalhostHttpOrigin = (
  url: URL,
  appEnvironment: string | undefined
): boolean => {
  return (
    appEnvironment === "development" &&
    url.protocol === "http:" &&
    url.hostname.endsWith(".localhost") &&
    url.port === ""
  );
};
