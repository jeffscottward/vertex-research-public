// Contact address in the User-Agent of automated research fetches (SEC EDGAR, House Clerk).
// The real address is server-side config (VERTEX_RESEARCH_CONTACT_EMAIL on QuantVPS), never
// committed; the placeholder is used when it is unset.
// Used by: research-lenses.ts, market-news.ts, congress-trades.ts; set by the oRPC route handler.

const PLACEHOLDER_CONTACT = "owner@example.com";
let contactEmail = PLACEHOLDER_CONTACT;

export const setResearchContactEmail = (email: string | undefined): void => {
  contactEmail = email?.trim() || PLACEHOLDER_CONTACT;
};

export const researchUserAgent = (tool: string): string =>
  `vertex-research ${tool} (personal research; ${contactEmail})`;
