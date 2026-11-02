const PLANETSCALE_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+psdb\.cloud$/u;

// pg treats sslrootcert as a filename. PlanetScale's canonical system hint instead
// means runtime trust roots; preserve verify-full and every other byte of the URL.
export const normalizePlanetScaleSystemRoot = (
  connectionString: string
): string => {
  let connectionUrl: URL;
  try {
    connectionUrl = new URL(connectionString);
  } catch {
    return connectionString;
  }

  const protocolPrefix = `${connectionUrl.protocol}//`;
  const queryIndex = connectionString.indexOf("?");
  const authorityStart = protocolPrefix.length;
  const authorityEndOffset = connectionString
    .slice(authorityStart)
    .search(/[/?#]/u);
  if (
    !connectionString.startsWith(protocolPrefix) ||
    queryIndex === -1 ||
    connectionString.includes("#") ||
    authorityEndOffset === -1
  ) {
    return connectionString;
  }

  const authority = connectionString.slice(
    authorityStart,
    authorityStart + authorityEndOffset
  );
  const rawHostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const expectedHostPort =
    connectionUrl.port === ""
      ? connectionUrl.hostname
      : `${connectionUrl.hostname}:${connectionUrl.port}`;
  const rootCertificates = connectionUrl.searchParams.getAll("sslrootcert");
  const sslModes = connectionUrl.searchParams.getAll("sslmode");
  const rawQueryParameters = connectionString.slice(queryIndex + 1).split("&");
  const systemRootIndex = rawQueryParameters.indexOf("sslrootcert=system");
  if (
    (connectionUrl.protocol !== "postgres:" &&
      connectionUrl.protocol !== "postgresql:") ||
    !PLANETSCALE_HOST_PATTERN.test(connectionUrl.hostname) ||
    rawHostPort !== expectedHostPort ||
    connectionUrl.searchParams.has("host") ||
    sslModes.length !== 1 ||
    sslModes[0] !== "verify-full" ||
    rootCertificates.length !== 1 ||
    rootCertificates[0] !== "system" ||
    systemRootIndex === -1 ||
    rawQueryParameters.lastIndexOf("sslrootcert=system") !== systemRootIndex ||
    rawQueryParameters.filter(
      (parameter) => parameter === "sslmode=verify-full"
    ).length !== 1
  ) {
    return connectionString;
  }

  rawQueryParameters.splice(systemRootIndex, 1);
  return `${connectionString.slice(0, queryIndex + 1)}${rawQueryParameters.join("&")}`;
};
