// Server-only service configuration shapes carried on ApiContext. This module is a leaf: it imports
// nothing, so context.ts can depend on it without an import cycle through the service modules.

/** Bearer-token URL of a read-only upstream (deploy status, market history, research lenses, ...). */
export type DeployStatusConfig = Readonly<{ url: string; token: string }>;

/** Server-only ntfy destination (VERTEX_PRICE_ALERTS_NTFY_*). Never returned to clients or logged. */
export type PriceAlertsNtfyConfig = Readonly<{
  origin: string;
  topic: string;
  token: string | null;
}>;

// Owner order screen (vertexOrders.*). VERTEX_ORDERS_ENABLED off => the mock gateway only.
export type VertexOrdersConfig = Readonly<{
  enabled: boolean;
  // VERTEX_ORDER_SUBMISSION, the repo-wide submission gate ("disabled" by default).
  // Live orders need BOTH this gate open and VERTEX_ORDERS_ENABLED; otherwise the mock is used.
  submission: string;
  bridgeUrl: string | null;
  // VERTEX_ORDER_BRIDGE_TOKEN: shared secret the bridge requires on every call. Never logged.
  bridgeToken?: string | null;
  confirmSecret: string;
}>;
