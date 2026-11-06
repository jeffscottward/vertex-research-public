import { MarketNewsWorkspace } from "../../../components/portal/market-news-workspace.tsx";

export const metadata = { title: "News monitor" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?days=1|3|7|30` opens that news window on the first paint (the workspace keeps it in sync). */
export default async function NewsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const days = (await searchParams)["days"];
  return (
    <MarketNewsWorkspace
      {...(typeof days === "string" ? { initialDays: days } : {})}
    />
  );
}
