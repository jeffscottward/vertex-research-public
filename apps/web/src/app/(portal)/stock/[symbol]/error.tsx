"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../../components/route-error-state.tsx";

export default function StockError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Stock detail"
      reset={reset}
      safety="No data was changed."
    />
  );
}
