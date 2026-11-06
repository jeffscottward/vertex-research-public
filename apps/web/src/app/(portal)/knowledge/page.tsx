import { parseKbChatUrl } from "@darkfactory/config/server";
import { PageHeader, Panel, StatusBadge } from "@darkfactory/ui";
import { headers } from "next/headers";

import { OperatorAccessRequired } from "../../../components/portal/agent-ops-client.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Knowledge chat" };

const PURPOSE =
  "Ask the trading and commodities knowledge bases that run on the rig.";

// Vertex is a trading platform, so the frame shows only the trading and commodities KBs.
// kb-chat's back end enforces this ?category= scope (knowledge-bases apps/kb-chat, scope.py).
const KB_CHAT_CATEGORIES = "trading,commodities";
const kbChatFrameSrc = (base: string): string => {
  const src = new URL(base);
  src.searchParams.set("category", KB_CHAT_CATEGORIES);
  return src.toString();
};

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
        <PageHeader
          description={PURPOSE}
          status={<StatusBadge status="neutral">Operator only</StatusBadge>}
          title="Knowledge chat"
        />
        <OperatorAccessRequired feature="knowledge-chat" />
      </div>
    );
  const url = parseKbChatUrl(process.env);
  return (
    <div className="space-y-6">
      <PageHeader
        description={PURPOSE}
        status={
          url === null ? (
            <StatusBadge status="warning">Not configured</StatusBadge>
          ) : (
            <StatusBadge status="info">Tailnet only</StatusBadge>
          )
        }
        title="Knowledge chat"
      />
      {url === null ? (
        <Panel title="Trading and commodities knowledge bases">
          <p
            className="text-muted-foreground text-sm"
            data-kb-chat="unavailable"
          >
            Available on the owner's tailnet device when the rig is online. This
            server has no kb-chat address (VERTEX_KB_CHAT_URL).
          </p>
        </Panel>
      ) : (
        <Panel
          description="Knowledge bases stay on the rig. This page works only on a tailnet device while the rig is online."
          flush
          title="Trading and commodities knowledge bases"
        >
          <iframe
            className="block h-[75vh] w-full"
            data-kb-chat="frame"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            src={kbChatFrameSrc(url)}
            title="Knowledge chat (kb-chat on the rig)"
          />
        </Panel>
      )}
    </div>
  );
}
