// What: mounts the click log for the signed-in portal (card vertex-click-log). Renders nothing.
// Used by: apps/web/src/components/portal-shell.tsx. See: docs/vertex-rebuild/click-log.md.
"use client";

import { useEffect } from "react";

import { installClickLog } from "./install.ts";

export const ClickLogListener = () => {
  useEffect(() => installClickLog(window), []);
  return null;
};
