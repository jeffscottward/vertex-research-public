import { assertUiLabEnabled, LAB_ROBOTS } from "../../lab/gate.ts";
import { LabIndex } from "../../lab/lab-views.tsx";
import {
  type LabSearchParamsRecord,
  toLabSearchParams,
} from "../../lab/params.ts";

export const metadata = { robots: LAB_ROBOTS, title: "UI lab" };

// UI lab index (dummy data only). Outside the (portal) session gate; 404 unless VERTEX_UI_LAB=on.
export default async function LabPage({
  searchParams,
}: {
  readonly searchParams: Promise<LabSearchParamsRecord>;
}) {
  assertUiLabEnabled();
  const search = toLabSearchParams(await searchParams).toString();
  return <LabIndex search={search} />;
}
