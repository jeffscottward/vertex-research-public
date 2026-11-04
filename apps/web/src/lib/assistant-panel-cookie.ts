// What: The assistant panel open/closed cookie ("vx.assistantPanel=open|closed", 1 year, Path=/, SameSite=Lax), so the server renders the saved state.
// Used by: apps/web/src/app/(portal)/layout.tsx (server read); apps/web/src/components/portal/assistant-panel.tsx (browser read and write).
// See: apps/web/src/lib/theme.ts (the theme cookie follows the same attributes).
import { MAX_COOKIE_HEADER_LENGTH } from "./theme.ts";

const ASSISTANT_PANEL_COOKIE = "vx.assistantPanel";

/** The saved choice: true (open), false (closed), or undefined when missing, duplicated or invalid. */
export const parseAssistantPanelCookie = (
  cookieHeader: string | null | undefined
): boolean | undefined => {
  if (
    typeof cookieHeader !== "string" ||
    cookieHeader.length > MAX_COOKIE_HEADER_LENGTH
  )
    return undefined;
  const values = cookieHeader
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith(`${ASSISTANT_PANEL_COOKIE}=`))
    .map((segment) => segment.slice(ASSISTANT_PANEL_COOKIE.length + 1));
  if (values.length !== 1) return undefined;
  return values[0] === "open"
    ? true
    : values[0] === "closed"
      ? false
      : undefined;
};

export const serializeAssistantPanelCookie = (open: boolean): string =>
  `${ASSISTANT_PANEL_COOKIE}=${open ? "open" : "closed"}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
