"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../../components/route-error-state.tsx";

export default function AccountSettingsError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Account settings"
      reset={reset}
      safety="No saved values were changed."
    />
  );
}
