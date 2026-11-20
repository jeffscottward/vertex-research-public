"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../../components/route-error-state.tsx";

export default function AdministrationSettingsError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Administration"
      reset={reset}
      safety="This view is read-only: no user or setting was changed."
    />
  );
}
