import { PageHeader } from "@darkfactory/ui";

import { BasketsWorkspace } from "../../../components/portal/baskets-workspace.tsx";

export const metadata = { title: "Baskets" };

type BasketsSearchParams = Promise<
  Readonly<Record<string, string | string[] | undefined>>
>;

export default async function BasketsPage({
  searchParams,
}: Readonly<{ searchParams: BasketsSearchParams }>) {
  const { symbol } = await searchParams;
  return (
    <div className="space-y-8">
      <PageHeader title="Baskets" />
      <BasketsWorkspace
        initialSymbol={typeof symbol === "string" ? symbol : null}
      />
    </div>
  );
}
