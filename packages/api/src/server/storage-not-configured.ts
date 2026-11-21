// A server with no repository wired never asked a database, so the 503 names configuration as the
// one cause instead of the STORAGE_ERROR default, which names a failed database request.
export const storageNotConfiguredMessage = (store: string): string =>
  `${store} storage is not configured on this server; nothing was saved. Set the database connection, then retry.`;
