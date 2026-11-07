import { parseDeepValueParams } from "../../../components/portal/deep-value-params.ts";
import { DeepValueWorkspace } from "../../../components/portal/deep-value-workspace.tsx";

export const metadata = { title: "Deep value screen" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/**
 * `?symbol=&show=&min=&hide=1&q=` restore the scored ticker and the screen filters; the workspace
 * renders the header and keeps the URL in sync.
 */
export default async function DeepValuePage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <DeepValueWorkspace initial={parseDeepValueParams(await searchParams)} />
  );
}
