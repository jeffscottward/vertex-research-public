import { parseKbChatUrl } from "@darkfactory/config/server";
import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";

import { OperatorAccessRequired } from "../../../components/portal/agent-ops-client.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Knowledge chat" };

// kb-chat embed, option a (audit section 7.2): kb-chat runs on the rig behind its tailnet gateway.
// Vertex only frames it, so KB text and model calls never pass through Vertex or QuantVPS.
// No API call guards this page (it only frames kb-chat), so it checks operator access itself:
// a non-operator never receives the kb-chat address.
export default async function KnowledgePage() {
  const requestHeaders = await headers();
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  if (session?.isOperator !== true)
    return (
      <div className="space-y-6">
        <PageHeader title="Knowledge chat" />
        <OperatorAccessRequired feature="knowledge-chat" />
      </div>
    );
  const url = parseKbChatUrl(process.env);
  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge chat" />
      {url === null ? (
        <p className="text-muted-foreground text-sm" data-kb-chat="unavailable">
          Available on the owner's tailnet device when the rig is online. This
          server has no kb-chat address (VERTEX_KB_CHAT_URL).
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs" role="note">
            Knowledge bases stay on the rig. This page works only on a tailnet
            device while the rig is online.
          </p>
          <iframe
            className="h-[75vh] w-full rounded-lg border"
            data-kb-chat="frame"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            src={url}
            title="Knowledge chat (kb-chat on the rig)"
          />
        </>
      )}
    </div>
  );
}
