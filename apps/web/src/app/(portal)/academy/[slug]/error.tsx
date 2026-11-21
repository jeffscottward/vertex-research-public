"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../../components/route-error-state.tsx";

export default function AcademyLessonError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Academy lesson"
      reset={reset}
      safety="No data was changed."
    />
  );
}
