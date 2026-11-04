import { PageHeader } from "@darkfactory/ui";

import { AssistantWorkspace } from "../../../components/portal/assistant-workspace.tsx";

export const metadata = { title: "Assistant" };

// The page fills the viewport below the portal header (dynamic viewport height, so mobile browser
// bars do not hide the composer), less the shell padding: 2rem on small screens, 3rem plus the
// 1rem inset margin from md. Only the message list scrolls; on very short screens the page scrolls.
export default function AssistantPage() {
  return (
    <div
      className="flex h-[calc(100dvh_-_var(--header-height)_-_2rem)] min-h-[32rem] flex-col gap-4 md:h-[calc(100dvh_-_var(--header-height)_-_4rem)] md:gap-6"
      data-assistant-page=""
    >
      <PageHeader title="Assistant" />
      <AssistantWorkspace />
    </div>
  );
}
