// The orderRef of a go-live draft's order (GO-LIVE 4). Shared by the send path (vertex-orders.ts,
// which writes it on the intent row and sends it to the bridge) and the draft queue
// (golive-drafts.ts, which reads where the send stands). No imports: the records-only queue
// module may use it.

/**
 * The orderRef of the one order a go-live draft may send: fixed by the draft id, so every send of
 * the draft (and a resend after a bridge refusal) carries the same ref at IBKR and in the store.
 */
export const goLiveOrderRef = async (draftId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`golive:${draftId}`)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `vertex-gl${hex.slice(0, 30)}`;
};
