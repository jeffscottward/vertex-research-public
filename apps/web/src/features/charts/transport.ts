import { createApiClient, type ApiClient } from "@darkfactory/api/client";
import { VertexPortfolioGetInputSchema } from "@darkfactory/api/vertex";
import { VertexModulesListOutputSchema } from "@darkfactory/api/vertex-chart-read";
import {
  classifyVertexFailure,
  VertexReadError,
  type VertexReadGateway,
} from "../../components/research/vertex-client.ts";

export type ChartReadTransport = Readonly<{
  scoped: (
    scope: Readonly<{
      accountAlias: string;
      environment: "research" | "paper" | "live";
    }>
  ) => VertexReadGateway;
}>;
const malformed = (): never => {
  throw new VertexReadError("malformed");
};
const check = (signal: AbortSignal): void => {
  if (signal.aborted) throw new VertexReadError("suspended");
};
const request = async <T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> => {
  check(signal);
  try {
    const result = await operation();
    check(signal);
    return result;
  } catch (error) {
    check(signal);
    throw new VertexReadError(classifyVertexFailure(error).kind);
  }
};

export const createChartReadTransport = (
  client: Pick<ApiClient, "vertex">
): ChartReadTransport => ({
  scoped: (rawScope) => {
    const scope = VertexPortfolioGetInputSchema.parse(rawScope);
    return {
      modules: (signal) =>
        request(signal, async () => {
          const value: unknown = await client.vertex.scoped.modules(scope, {
            signal,
          });
          const result = VertexModulesListOutputSchema.safeParse(value);
          if (!result.success) return malformed();
          return result.data;
        }),
    };
  },
});

// Stable lazy API client; no credentials, actor header, provider URL or cache.
export const createBrowserChartReadTransport = (): ChartReadTransport => {
  let current: ChartReadTransport | undefined;
  const transport = () => {
    current ??= createChartReadTransport(
      createApiClient({ baseUrl: window.location.origin })
    );
    return current;
  };
  return {
    scoped: (scope) => ({
      modules: (signal) => transport().scoped(scope).modules(signal),
    }),
  };
};
