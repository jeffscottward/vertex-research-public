import { assertUiLabEnabled, LAB_ROBOTS } from "../../../lab/gate.ts";
import { LabEntryView } from "../../../lab/lab-views.tsx";
import {
  type LabSearchParamsRecord,
  toLabSearchParams,
} from "../../../lab/params.ts";

export const metadata = { robots: LAB_ROBOTS, title: "UI lab entry" };

// One UI lab entry, e.g. /lab/charts?symbol=NVDA. 404 unless VERTEX_UI_LAB=on.
export default async function LabEntryPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly entry: string }>;
  readonly searchParams: Promise<LabSearchParamsRecord>;
}) {
  assertUiLabEnabled();
  const { entry } = await params;
  const search = toLabSearchParams(await searchParams).toString();
  return <LabEntryView id={entry} search={search} />;
}
