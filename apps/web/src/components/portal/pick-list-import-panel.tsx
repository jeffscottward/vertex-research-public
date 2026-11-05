"use client";

import type { PickListOutput } from "@darkfactory/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from "@darkfactory/ui";
import { Upload } from "lucide-react";
import { useId, useState } from "react";

import {
  MANUAL_IMPORT_SOURCES,
  type PickListImportParse,
  parsePickListText,
  slugifyListName,
} from "./pick-list-import.ts";
import {
  describePickListFailure,
  type PickListGateway,
} from "./pick-lists-client.ts";

export interface PickListImportPanelProps {
  readonly gateway: PickListGateway;
  readonly onImported: (list: PickListOutput) => void;
  /** Today's date (YYYY-MM-DD); injectable for tests. */
  readonly today?: string;
}

type SaveState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "saving" }>
  | Readonly<{ type: "done"; name: string; count: number }>
  | Readonly<{ type: "error"; message: string }>;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Manual list import: paste or upload a list copied by hand. No site is contacted. */
export const PickListImportPanel = ({
  gateway,
  onImported,
  today,
}: PickListImportPanelProps) => {
  const id = useId();
  const [sourceId, setSourceId] = useState<string>(MANUAL_IMPORT_SOURCES[0].id);
  const [name, setName] = useState("");
  const [asOf, setAsOf] = useState(() => today ?? todayIso());
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PickListImportParse | null>(null);
  const [save, setSave] = useState<SaveState>({ type: "idle" });

  const source =
    MANUAL_IMPORT_SOURCES.find((entry) => entry.id === sourceId) ??
    MANUAL_IMPORT_SOURCES[0];
  const slug = slugifyListName(name);
  const canSave = preview !== null && preview.members.length > 0 && slug !== "";

  const updateText = (next: string) => {
    setText(next);
    setPreview(null);
    setSave({ type: "idle" });
  };

  const submit = async () => {
    if (preview === null || !canSave) return;
    setSave({ type: "saving" });
    try {
      const list = await gateway.import({
        asOf,
        list: { name: name.trim(), slug },
        members: [...preview.members],
        method: "manual",
        source: source.id,
        sourceLabel: source.label,
      });
      setSave({
        count: list.latest.members.length,
        name: list.name,
        type: "done",
      });
      return onImported(list);
    } catch (error) {
      return setSave({
        message: describePickListFailure(error),
        type: "error",
      });
    }
  };

  return (
    <Card aria-label="Import list" role="region">
      <CardHeader>
        <CardTitle headingLevel={2}>Import list</CardTitle>
        <CardDescription>
          Paste tickers or a CSV export you copied by hand. Vertex does not
          contact the source site.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          aria-label="Import list"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            return void submit();
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1 text-sm" htmlFor={`${id}-source`}>
              <span className="block">Source</span>
              <select
                className="h-11 rounded-md border bg-background px-3"
                id={`${id}-source`}
                onChange={(event) => setSourceId(event.target.value)}
                value={sourceId}
              >
                {MANUAL_IMPORT_SOURCES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm" htmlFor={`${id}-name`}>
              <span className="block">List name</span>
              <Input
                className="w-64"
                id={`${id}-name`}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <label className="space-y-1 text-sm" htmlFor={`${id}-asof`}>
              <span className="block">As of</span>
              <Input
                className="w-44"
                id={`${id}-asof`}
                onChange={(event) => setAsOf(event.target.value)}
                required
                type="date"
                value={asOf}
              />
            </label>
          </div>
          <label className="block space-y-1 text-sm" htmlFor={`${id}-text`}>
            <span className="block">Tickers or CSV</span>
            <Textarea
              className="min-h-32 font-mono"
              id={`${id}-text`}
              onChange={(event) => updateText(event.target.value)}
              placeholder={"Symbol,Weight,Date added\nAAPL,5%,2026-10-01"}
              value={text}
            />
          </label>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <Upload aria-hidden="true" className="size-4" />
            <span>CSV file</span>
            <input
              accept=".csv,.txt,text/csv,text/plain"
              aria-label="CSV file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined)
                  return void file.text().then(updateText);
              }}
              type="file"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={text.trim() === ""}
              onClick={() => setPreview(parsePickListText(text))}
              type="button"
              variant="secondary"
            >
              Preview
            </Button>
            <Button
              disabled={!canSave}
              loading={save.type === "saving"}
              loadingLabel="Saving list"
              type="submit"
            >
              Save list
            </Button>
          </div>
          {preview === null ? null : (
            <div className="space-y-1 text-sm" role="status">
              <p>
                {`${preview.members.length} tickers ready: ${preview.members
                  .map((member) => member.symbol)
                  .join(", ")}`}
              </p>
              {preview.rejects.length === 0 ? null : (
                <div>
                  <p className="text-destructive">
                    {`${preview.rejects.length} rejected:`}
                  </p>
                  <ul aria-label="Rejected rows" className="list-disc pl-5">
                    {preview.rejects.map((reject) => (
                      <li key={`${reject.line}-${reject.text}`}>
                        {`Line ${reject.line} "${reject.text}": ${reject.reason}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {save.type === "done" ? (
            <p className="text-sm" role="status">
              {`Saved ${save.name} with ${save.count} members. Use Make bucket on its card.`}
            </p>
          ) : null}
          {save.type === "error" ? (
            <p className="text-destructive text-sm" role="alert">
              {save.message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
};
