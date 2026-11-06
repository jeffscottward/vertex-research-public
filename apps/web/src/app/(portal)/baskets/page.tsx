import { BasketsWorkspace } from "../../../components/portal/baskets-workspace.tsx";

export const metadata = { title: "Baskets" };

type BasketsSearchParams = Promise<
  Readonly<Record<string, string | string[] | undefined>>
>;

export default async function BasketsPage({
  searchParams,
}: Readonly<{ searchParams: BasketsSearchParams }>) {
  const { basket, symbol } = await searchParams;
  const wanted = typeof basket === "string" ? basket : symbol;
  return (
    <div className="space-y-8">
      <BasketsWorkspace
        initialBasket={typeof wanted === "string" ? wanted : null}
      />
    </div>
  );
}
