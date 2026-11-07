import { parseRotationMatrixParams } from "../../../components/portal/rotation-matrix-params.ts";
import { RotationMatrixWorkspace } from "../../../components/portal/rotation-matrix-workspace.tsx";

export const metadata = { title: "Rotation matrix" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?period=` restores the matrix period; the workspace renders the header and keeps the URL in sync. */
export default async function RotationMatrixPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <RotationMatrixWorkspace
      initial={parseRotationMatrixParams(await searchParams)}
    />
  );
}
