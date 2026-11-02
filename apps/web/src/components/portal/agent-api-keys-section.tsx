"use client";

import type { AgentApiKeyOutput } from "@darkfactory/api";
import { Button, Input } from "@darkfactory/ui";
import { Copy, KeyRound, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  InfoGlyph,
  createBrowserAgentApiKeysGateway,
  describeAgentApiKeyFailure,
  isOperatorAccessDenied,
  formatTimestamp,
  type AgentApiKeysGateway,
} from "./agent-ops-client.tsx";

export interface AgentApiKeysSectionProps {
  readonly gateway?: AgentApiKeysGateway;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; keys: AgentApiKeyOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

// Shown once after creation; cleared on dismiss and never persisted.
type Revealed = Readonly<{ id: string; name: string; key: string }>;

const NAME_MAX = 64;

export const displayKeyPrefix = (
  key: Pick<AgentApiKeyOutput, "start" | "prefix">
): string => {
  const shown = key.start ?? key.prefix;
  return shown === null ? "—" : `${shown}…`;
};

export const AgentApiKeysSection = ({
  gateway: suppliedGateway,
}: AgentApiKeysSectionProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentApiKeysGateway()
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ type: "ready", keys: await gateway.list() });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { type: "error", message: describeAgentApiKeyFailure(error) }
      );
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > NAME_MAX) {
      setFeedback(`Name is required (1-${NAME_MAX} characters).`);
      return;
    }
    setBusy(true);
    try {
      const created = await gateway.create(trimmed, access);
      setRevealed({
        id: created.apiKey.id,
        name: created.apiKey.name ?? trimmed,
        key: created.key,
      });
      setState((current) =>
        current.type === "ready"
          ? {
              type: "ready",
              keys: [
                created.apiKey,
                ...current.keys.filter((row) => row.id !== created.apiKey.id),
              ],
            }
          : current
      );
      setName("");
      setFeedback(
        `Created key ${created.apiKey.name ?? trimmed}. Copy it now; it is shown only once.`
      );
    } catch (error) {
      setFeedback(describeAgentApiKeyFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: AgentApiKeyOutput): Promise<void> => {
    if (confirmId !== row.id) {
      setConfirmId(row.id);
      return;
    }
    setBusy(true);
    try {
      await gateway.revoke(row.id);
      setConfirmId(null);
      if (revealed?.id === row.id) setRevealed(null);
      setState((current) =>
        current.type === "ready"
          ? {
              type: "ready",
              keys: current.keys.filter((key) => key.id !== row.id),
            }
          : current
      );
      setFeedback(
        `Revoked ${row.name ?? row.id}. Agents using it now get 401.`
      );
    } catch (error) {
      setFeedback(describeAgentApiKeyFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (revealed === null) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setFeedback("Key copied.");
    } catch {
      setFeedback("Copy failed. Select the key and copy it manually.");
    }
  };

  // Non-operators: the Agent runs workspace above already shows "Operator access
  // required"; render nothing here rather than a second notice or a key form.
  if (state.type === "forbidden") return null;

  return (
    <section aria-labelledby="agent-api-keys" className="space-y-3">
      <h2 className="font-medium text-sm" id="agent-api-keys">
        Agent API keys
        <InfoGlyph text="Agents send the key in the x-api-key header (or Authorization: Bearer for MCP clients at /api/mcp). A key can call only agentOps.*, papers.* and strategyLibrary.*. Read keys list and get; write keys also create and update. Keys are stored hashed." />
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 text-xs">
          Key name
          <Input
            aria-label="API key name"
            maxLength={NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. omp-rig"
            value={name}
          />
        </label>
        <label className="text-xs">
          Access
          <select
            aria-label="API key access"
            className="block min-h-11 rounded-md border border-border bg-background px-2 text-sm"
            onChange={(event) =>
              setAccess(event.target.value === "write" ? "write" : "read")
            }
            value={access}
          >
            <option value="read">Read</option>
            <option value="write">Read and write</option>
          </select>
        </label>
        <Button disabled={busy} onClick={() => void create()} type="button">
          <KeyRound aria-hidden="true" className="size-4" />
          Create key
        </Button>
        <Button
          aria-label="Reload API keys"
          onClick={() => void load()}
          type="button"
          variant="secondary"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Reload
        </Button>
      </div>
      {revealed === null ? null : (
        <div
          aria-label="New API key"
          className="space-y-2 rounded-md border border-border p-3"
          role="region"
        >
          <p className="text-sm">
            Copy the key for{" "}
            <span className="font-medium">{revealed.name}</span> now. It is
            shown only once and cannot be recovered; revoke and create a new key
            if lost.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Full API key"
              className="font-mono"
              readOnly
              value={revealed.key}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              onClick={() => void copy()}
              type="button"
              variant="secondary"
            >
              <Copy aria-hidden="true" className="size-4" />
              Copy
            </Button>
            <Button
              onClick={() => setRevealed(null)}
              type="button"
              variant="ghost"
            >
              Done
            </Button>
          </div>
        </div>
      )}
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading API keys…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : state.keys.length === 0 ? (
        <p className="text-muted-foreground text-sm">No API keys.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Agent API keys</caption>
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground text-xs">
              <th scope="col">Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">Access</th>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Last used (UTC)</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.keys.map((row) => {
              return (
                <tr
                  className="border-border border-b"
                  data-api-key-id={row.id}
                  key={row.id}
                >
                  <th className="py-1 font-normal" scope="row">
                    {row.name ?? "(unnamed)"}
                  </th>
                  <td className="py-1 font-mono text-xs">
                    {displayKeyPrefix(row)}
                  </td>
                  <td className="py-1 text-xs" data-col="access">
                    {row.access === "write"
                      ? "Read and write"
                      : row.access === "read"
                        ? "Read"
                        : "—"}
                  </td>
                  <td className="py-1 font-mono text-xs">
                    {formatTimestamp(row.createdAt)}
                  </td>
                  <td className="py-1 font-mono text-muted-foreground text-xs">
                    {row.lastUsedAt === null
                      ? "Never"
                      : formatTimestamp(row.lastUsedAt)}
                  </td>
                  <td className="py-1 text-right">
                    <Button
                      aria-label={`${confirmId === row.id ? "Confirm revoke" : "Revoke"} ${row.name ?? row.id}`}
                      disabled={busy}
                      onClick={() => void revoke(row)}
                      type="button"
                      variant={
                        confirmId === row.id ? "destructive" : "secondary"
                      }
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      {confirmId === row.id ? "Confirm revoke" : "Revoke"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
};
