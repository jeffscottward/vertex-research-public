import { PapersWorkspace } from "../../../components/portal/papers-workspace.tsx";

export const metadata = { title: "Papers" };

type PapersSearchParams = Promise<
  Readonly<Record<string, string | string[] | undefined>>
>;

export default async function PapersPage({
  searchParams,
}: Readonly<{ searchParams: PapersSearchParams }>) {
  const { status } = await searchParams;
  return (
    <div className="space-y-8">
      <PapersWorkspace
        initialStatus={typeof status === "string" ? status : null}
      />
    </div>
  );
}
