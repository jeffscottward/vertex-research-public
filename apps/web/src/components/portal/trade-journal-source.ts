// What: server-side choice of the snapshot the Trade Journal reads. Server components only
// (it reads the server environment).
// Used by: app/(portal)/journal/page.tsx, app/(portal)/dashboard/page.tsx (journal widget).
import {
  type EnvironmentSource,
  parseServerEnv,
} from "@darkfactory/config/server";

import type { JournalSource } from "./trade-journal-client.ts";

/**
 * ibkr-monitor first (IBKR_MONITOR_URL, the reader /portfolio uses), then the vertex-portfolio
 * service (VERTEX_PORTFOLIO_URL). null: neither is set (or the environment is invalid), so the
 * journal shows "not configured" and sends no snapshot request.
 */
export const resolveJournalSource = (
  source: EnvironmentSource = process.env
): JournalSource | null => {
  try {
    const env = parseServerEnv(source);
    if (env.IBKR_MONITOR_URL !== undefined) return "ibkr-monitor";
    if (env.VERTEX_PORTFOLIO_URL !== undefined) return "portfolio-monitor";
    return null;
  } catch {
    return null;
  }
};
