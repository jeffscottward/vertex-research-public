import type { VertexFinalGate } from "@darkfactory/api";
import { StatusBadge } from "@darkfactory/ui";

// Final JEV order gate verdict (merge plan P6), shown on every order review. The server decides;
// this panel only shows the decision. null = live mode: nothing is shown and the existing gates apply.

const STRUCTURE: Readonly<Record<VertexFinalGate["structure"], string>> = {
  "credit-vertical": "Credit vertical (defined width)",
  "debit-vertical": "Debit vertical",
  "long-option": "Long option",
  rejected: "Not a defined-risk structure",
  "risk-reducing": "Risk-reducing (close)",
};

export const FinalGatePanel = ({
  gate,
}: Readonly<{ gate: VertexFinalGate | null | undefined }>) => {
  if (gate === null || gate === undefined) return null;
  return (
    <section
      aria-label="Final JEV gate"
      className="space-y-2 rounded-md border border-border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Final JEV gate</span>
        <StatusBadge
          status={gate.decision === "allow" ? "success" : "destructive"}
        >
          {gate.decision === "allow" ? "Allow" : "Deny"}
        </StatusBadge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Structure</dt>
        <dd>{STRUCTURE[gate.structure]}</dd>
        <dt className="text-muted-foreground">Max loss</dt>
        <dd className="tabular-nums">
          {gate.maxLoss === null
            ? "n/a"
            : `$${gate.maxLoss.toLocaleString("en-US")}${gate.maxLossPct === null ? "" : ` (${gate.maxLossPct}% of account, limit 2%)`}`}
        </dd>
        <dt className="text-muted-foreground">JEV verdict</dt>
        <dd>
          {gate.jevStance ?? "none"} · {gate.jevState}
        </dd>
      </dl>
      {gate.reasons.length === 0 ? null : (
        <ul className="list-disc space-y-1 pl-5">
          {gate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
};
