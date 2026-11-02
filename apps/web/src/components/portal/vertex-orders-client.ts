"use client";

import { createApiClient, type ApiClient } from "@darkfactory/api";

// Owner order screen calls (vertexOrders.*). Every submit/cancel needs the confirm token from the
// matching preview call; the server refuses anything else.
export type VertexOrdersGateway = Readonly<{
  status: ApiClient["vertexOrders"]["status"];
  preview: ApiClient["vertexOrders"]["preview"];
  submit: ApiClient["vertexOrders"]["submit"];
  cancelPreview: ApiClient["vertexOrders"]["cancelPreview"];
  cancelSubmit: ApiClient["vertexOrders"]["cancelSubmit"];
}>;

export const createBrowserVertexOrdersGateway = (): VertexOrdersGateway => {
  let client: ApiClient | undefined;
  const orders = () => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client.vertexOrders;
  };
  return Object.freeze({
    status: (input) => orders().status(input),
    preview: (input) => orders().preview(input),
    submit: (input) => orders().submit(input),
    cancelPreview: (input) => orders().cancelPreview(input),
    cancelSubmit: (input) => orders().cancelSubmit(input),
  });
};

// Shows the server's message (rule reasons, rate limit, confirm expiry) to the owner.
export const orderErrorMessage = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  return typeof message === "string" && message.trim() !== ""
    ? message
    : "Request failed";
};
