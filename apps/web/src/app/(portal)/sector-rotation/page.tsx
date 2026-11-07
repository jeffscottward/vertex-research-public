import { parseSectorRotationParams } from "../../../components/portal/sector-rotation-params.ts";
import { SectorRotationWorkspace } from "../../../components/portal/sector-rotation-workspace.tsx";

export const metadata = { title: "Sector rotation" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?timeframe=&universe=&tail=` restore the map settings; the workspace keeps the URL in sync. */
export default async function SectorRotationPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <SectorRotationWorkspace
      initial={parseSectorRotationParams(await searchParams)}
    />
  );
}
