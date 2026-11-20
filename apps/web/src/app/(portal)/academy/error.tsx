"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../components/route-error-state.tsx";

export default function AcademyError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Academy"
      reset={reset}
      safety="No data was changed."
    />
  );
}
