// A server with no repository wired never asked a database, so the 503 names configuration as the
// cause instead of the default "did not answer" text of STORAGE_ERROR.
export const storageNotConfiguredMessage = (store: string): string =>
  `${store} storage is not configured on this server; nothing was saved. Set the database connection, then retry.`;
