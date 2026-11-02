// Legacy URL: Data & evidence was dropped (owner decision 2026-10-30), so old
// links land on Research instead of a 404.
import { redirect } from "next/navigation";

import { LEGACY_ROUTE_REDIRECTS } from "../../../lib/navigation.ts";

export default function LegacyDataPage() {
  return redirect(LEGACY_ROUTE_REDIRECTS["/data"]);
}
