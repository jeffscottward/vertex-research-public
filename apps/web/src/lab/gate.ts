// What: Server gate for every /lab route: 404 unless VERTEX_UI_LAB=on and APP_ENV is development or test.
// Used by: apps/web/src/app/lab/page.tsx, apps/web/src/app/lab/[entry]/page.tsx.
import { isUiLabEnabled } from "@darkfactory/config/server";
import { notFound } from "next/navigation";

export const assertUiLabEnabled = (
  source: Readonly<Record<string, string | undefined>> = process.env
): void => {
  if (!isUiLabEnabled(source)) notFound();
};

/** Lab pages are never indexed. */
export const LAB_ROBOTS = Object.freeze({ follow: false, index: false });
