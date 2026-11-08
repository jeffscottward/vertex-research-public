"use client";

import { type ApiClient, createApiClient } from "@darkfactory/api";
import {
  Badge,
  Button,
  Input,
  Label,
  Panel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import {
  createContext,
  type FormEvent,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  OPERATOR_ACCESS_REQUIRED_TEXT,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";

// Semantic terms (docs/vertex-rebuild/agent-semantic-layer.md): the operator reads the catalog of
// business terms the assistant may answer, edits a term, its SQL attribute or a relationship
// (semanticTerms.update, which removes the certification) and certifies it (semanticTerms.certify).
// Read only for trading: nothing here places an order or changes a risk setting.

type SemanticApi = ApiClient["semanticTerms"];
export type SemanticCatalog = Awaited<ReturnType<SemanticApi["catalog"]>>;
export type SemanticUpdateInput = Parameters<SemanticApi["update"]>[0];
export type SemanticCertifyInput = Parameters<SemanticApi["certify"]>[0];
type CatalogTerm = SemanticCatalog["terms"][number];
type CatalogAttribute = SemanticCatalog["attributes"][number];
type CatalogRelationship = SemanticCatalog["relationships"][number];
type Kind = SemanticCertifyInput["kind"];
type Certification = Pick<
  CatalogTerm,
  | "certified"
  | "certifiedAt"
  | "certifiedBy"
  | "certificationNote"
  | "updatedAt"
>;

/** semanticTerms.catalog canWrite: false hides every edit and certify control. */
const CanWriteContext = createContext(true);

export interface SemanticTermsGateway {
  readonly catalog: () => Promise<SemanticCatalog>;
  readonly certify: (input: SemanticCertifyInput) => Promise<unknown>;
  readonly update: (input: SemanticUpdateInput) => Promise<unknown>;
}

export const createBrowserSemanticTermsGateway = (): SemanticTermsGateway => {
  let client: ApiClient | undefined;
  const api = (): SemanticApi => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client.semanticTerms;
  };
  return Object.freeze({
    catalog: () => api().catalog({}),
    certify: (input: SemanticCertifyInput) => api().certify(input),
    update: (input: SemanticUpdateInput) => api().update(input),
  });
};

export const NOT_CERTIFIED_TEXT =
  "Not certified: the assistant gives no value for this term";
export const CATALOG_UNAVAILABLE_TEXT =
  "Semantic catalog unavailable. The database did not answer; nothing was changed.";

export const CERTIFY_CONFLICT_TEXT =
  "This row changed after you loaded it. Review the new version, then certify again.";
export const READ_ONLY_TEXT =
  "Read only: your account can review the catalog but cannot edit or certify it.";

export type SemanticFailure = Readonly<{
  kind: "forbidden" | "unavailable" | "conflict" | "error";
  message: string;
}>;

const field = (error: unknown, key: string): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, key)
    : undefined;

/** 403 -> operator access required, 503 -> catalog unavailable, anything else verbatim. */
export const describeSemanticFailure = (error: unknown): SemanticFailure => {
  const code = field(error, "code");
  const status = field(error, "status");
  if (code === "FORBIDDEN" || status === 403)
    return { kind: "forbidden", message: `${OPERATOR_ACCESS_REQUIRED_TEXT}.` };
  if (code === "STORAGE_ERROR" || status === 503)
    return { kind: "unavailable", message: CATALOG_UNAVAILABLE_TEXT };
  if (code === "CONFLICT" || status === 409)
    return { kind: "conflict", message: CERTIFY_CONFLICT_TEXT };
  if (code === "UNAUTHORIZED" || status === 401)
    return { kind: "error", message: "Session expired. Sign in again." };
  return {
    kind: "error",
    message: error instanceof Error ? error.message : "Unknown error",
  };
};

const when = (value: string | null): string =>
  value === null
    ? "unknown time"
    : new Date(value).toLocaleString("en-US", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      });

type Write = (
  run: (gateway: SemanticTermsGateway) => Promise<unknown>,
  done: string
) => Promise<boolean>;

const CertificationBlock = ({
  id,
  item,
  kind,
  pending,
  uncertifiedText,
  write,
}: Readonly<{
  id: string;
  item: Certification;
  kind: Kind;
  pending: boolean;
  uncertifiedText: string;
  write: Write;
}>) => {
  const canWrite = useContext(CanWriteContext);
  const [note, setNote] = useState("");
  const noteId = `semantic-note-${kind}-${id}`;
  const submit = async (certified: boolean) => {
    const trimmed = note.trim();
    const ok = await write(
      (gateway) =>
        gateway.certify({
          certified,
          expectedUpdatedAt: item.updatedAt,
          id,
          kind,
          note: trimmed === "" ? null : trimmed,
        }),
      certified
        ? `Certified ${kind} ${id}.`
        : `Removed certification from ${kind} ${id}.`
    );
    if (ok) setNote("");
  };
  return (
    <div className="space-y-2" data-certification={kind}>
      {item.certified ? (
        <div className="space-y-1 text-sm">
          <Badge variant="secondary">Certified</Badge>{" "}
          <span className="text-muted-foreground">
            {`${when(item.certifiedAt)} by ${item.certifiedBy ?? "unknown"}`}
          </span>
          {item.certificationNote === null ? null : (
            <p className="text-muted-foreground">
              Note: {item.certificationNote}
            </p>
          )}
        </div>
      ) : (
        <p
          className="font-medium text-destructive text-sm"
          data-uncertified="true"
        >
          {uncertifiedText}
        </p>
      )}
      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={noteId}>Certification note (optional)</Label>
            <Input
              id={noteId}
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
          </div>
          {item.certified ? (
            <Button
              disabled={pending}
              onClick={() => void submit(false)}
              variant="outline"
            >
              Remove certification
            </Button>
          ) : (
            <Button disabled={pending} onClick={() => void submit(true)}>
              Certify
            </Button>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm" data-read-only="true">
          {READ_ONLY_TEXT}
        </p>
      )}
    </div>
  );
};

type FieldSpec = Readonly<{
  name: string;
  label: string;
  value: string;
  multiline?: boolean;
  mono?: boolean;
}>;

const EditForm = ({
  fields,
  id,
  kind,
  pending,
  toInput,
  write,
}: Readonly<{
  fields: readonly FieldSpec[];
  id: string;
  kind: Kind;
  pending: boolean;
  toInput: (changed: Readonly<Record<string, string>>) => SemanticUpdateInput;
  write: Write;
}>) => {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const canWrite = useContext(CanWriteContext);
  // The read-only note sits beside the certification block; no Edit button here.
  if (!canWrite) return null;
  if (!open)
    return (
      <Button
        onClick={() => {
          setValues(
            Object.fromEntries(fields.map((spec) => [spec.name, spec.value]))
          );
          setMessage(null);
          setOpen(true);
        }}
        variant="outline"
      >
        Edit {kind}
      </Button>
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const initial = new Map(
      fields.map((spec) => [spec.name, spec.value.trim()])
    );
    const changed = Object.fromEntries(
      Object.entries(values)
        .map(([name, value]) => [name, value.trim()] as const)
        .filter(([name, value]) => value !== initial.get(name))
    );
    if (Object.keys(changed).length === 0)
      return setMessage("No changes to save.");
    const ok = await write(
      (gateway) => gateway.update(toInput(changed)),
      `Saved ${kind} ${id}. Its certification was removed: certify it again before the assistant uses it.`
    );
    if (ok) setOpen(false);
  };
  return (
    <form
      aria-label={`Edit ${kind} ${id}`}
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => void save(event)}
    >
      {fields.map((spec) => {
        const inputId = `semantic-${kind}-${id}-${spec.name}`;
        const onChange = (value: string) =>
          setValues((current) => ({ ...current, [spec.name]: value }));
        return (
          <div className="space-y-1" key={spec.name}>
            <Label htmlFor={inputId}>{spec.label}</Label>
            {spec.multiline ? (
              <Textarea
                className={spec.mono ? "font-mono text-xs" : undefined}
                id={inputId}
                onChange={(event) => onChange(event.target.value)}
                rows={spec.mono ? 8 : 3}
                value={values[spec.name]}
              />
            ) : (
              <Input
                id={inputId}
                onChange={(event) => onChange(event.target.value)}
                value={values[spec.name]}
              />
            )}
          </div>
        );
      })}
      <p className="text-muted-foreground text-xs">
        Saving removes the certification.
      </p>
      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={pending} type="submit">
          Save
        </Button>
        <Button onClick={() => setOpen(false)} type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
};

const splitSynonyms = (value: string): string[] =>
  value
    .split(",")
    .map((synonym) => synonym.trim())
    .filter((synonym) => synonym !== "");

const AttributeView = ({
  attribute,
  pending,
  write,
}: Readonly<{
  attribute: CatalogAttribute;
  pending: boolean;
  write: Write;
}>) => (
  <div
    className="space-y-2 border-border border-t pt-3"
    data-attribute={attribute.id}
  >
    <h4 className="font-medium text-sm">
      SQL attribute <code className="font-mono">{attribute.id}</code>
    </h4>
    <p className="text-sm">{attribute.description}</p>
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
      <code>{attribute.sql}</code>
    </pre>
    <CertificationBlock
      id={attribute.id}
      item={attribute}
      kind="attribute"
      pending={pending}
      uncertifiedText={NOT_CERTIFIED_TEXT}
      write={write}
    />
    <EditForm
      fields={[
        {
          label: "Description",
          multiline: true,
          name: "description",
          value: attribute.description,
        },
        {
          label: "SQL",
          mono: true,
          multiline: true,
          name: "sql",
          value: attribute.sql,
        },
      ]}
      id={attribute.id}
      kind="attribute"
      pending={pending}
      toInput={(changed) => ({
        id: attribute.id,
        kind: "attribute",
        ...changed,
      })}
      write={write}
    />
  </div>
);

const TermView = ({
  attributes,
  pending,
  term,
  write,
}: Readonly<{
  attributes: readonly CatalogAttribute[];
  pending: boolean;
  term: CatalogTerm;
  write: Write;
}>) => (
  <Panel
    data-certified={String(term.certified)}
    data-term={term.id}
    description={term.description}
    title={term.label}
  >
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Id</dt>
        <dd>
          <code className="font-mono">{term.id}</code>
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd>{term.source}</dd>
        <dt className="text-muted-foreground">Unit</dt>
        <dd>{term.unit === "" ? "—" : term.unit}</dd>
        <dt className="text-muted-foreground">Synonyms</dt>
        <dd>{term.synonyms.length === 0 ? "—" : term.synonyms.join(", ")}</dd>
      </dl>
      <CertificationBlock
        id={term.id}
        item={term}
        kind="term"
        pending={pending}
        uncertifiedText={NOT_CERTIFIED_TEXT}
        write={write}
      />
      <EditForm
        fields={[
          { label: "Label", name: "label", value: term.label },
          {
            label: "Description",
            multiline: true,
            name: "description",
            value: term.description,
          },
          {
            label: "Synonyms (comma-separated)",
            name: "synonyms",
            value: term.synonyms.join(", "),
          },
          { label: "Unit", name: "unit", value: term.unit },
        ]}
        id={term.id}
        kind="term"
        pending={pending}
        toInput={({ synonyms, ...rest }) => ({
          id: term.id,
          kind: "term",
          ...rest,
          ...(synonyms === undefined
            ? {}
            : { synonyms: splitSynonyms(synonyms) }),
        })}
        write={write}
      />
      {attributes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No SQL attribute for this term.
        </p>
      ) : (
        attributes.map((attribute) => (
          <AttributeView
            attribute={attribute}
            key={attribute.id}
            pending={pending}
            write={write}
          />
        ))
      )}
    </div>
  </Panel>
);

const RelationshipsTable = ({
  pending,
  relationships,
  write,
}: Readonly<{
  pending: boolean;
  relationships: readonly CatalogRelationship[];
  write: Write;
}>) => (
  <Panel title="Relationships">
    <Table>
      <TableCaption>
        Joins the certified SQL may use between tables.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Relationship</TableHead>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
          <TableHead>Cardinality</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Certification</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {relationships.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6}>No relationships in the catalog.</TableCell>
          </TableRow>
        ) : (
          relationships.map((relationship) => (
            <TableRow
              data-certified={String(relationship.certified)}
              data-relationship={relationship.id}
              key={relationship.id}
            >
              <TableCell>
                <code className="font-mono">{relationship.id}</code>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {`${relationship.fromTable}.${relationship.fromColumn}`}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {`${relationship.toTable}.${relationship.toColumn}`}
              </TableCell>
              <TableCell>{relationship.cardinality}</TableCell>
              <TableCell>
                <div className="space-y-2">
                  <p>{relationship.description}</p>
                  <EditForm
                    fields={[
                      {
                        label: "Description",
                        multiline: true,
                        name: "description",
                        value: relationship.description,
                      },
                    ]}
                    id={relationship.id}
                    kind="relationship"
                    pending={pending}
                    toInput={(changed) => ({
                      id: relationship.id,
                      kind: "relationship",
                      ...changed,
                    })}
                    write={write}
                  />
                </div>
              </TableCell>
              <TableCell>
                <CertificationBlock
                  id={relationship.id}
                  item={relationship}
                  kind="relationship"
                  pending={pending}
                  uncertifiedText="Not certified: the assistant does not use this relationship"
                  write={write}
                />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  </Panel>
);

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: SemanticCatalog }>;

type Notice = Readonly<{ tone: "success" | "error"; text: string }>;

export const SemanticTermsWorkspace = ({
  gateway: supplied,
}: Readonly<{ gateway?: SemanticTermsGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserSemanticTermsGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      return setState({ data: await gateway.catalog(), type: "ready" });
    } catch (error) {
      const failure = describeSemanticFailure(error);
      return setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { message: failure.message, type: "error" }
      );
    }
  }, [gateway]);
  useEffect(() => {
    void load();
  }, [load]);

  const write: Write = async (run, done) => {
    setPending(true);
    setNotice(null);
    try {
      await run(gateway);
      setNotice({ text: done, tone: "success" });
      return true;
    } catch (error) {
      setNotice({
        text: describeSemanticFailure(error).message,
        tone: "error",
      });
      return false;
    } finally {
      // Refresh after every write: a failed write may still have changed nothing or something.
      await load();
      setPending(false);
    }
  };

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="semantic-terms" />;
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading semantic terms…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-3" data-semantic-state="error">
        <p className="text-sm" role="alert">
          {state.message}
        </p>
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  const uncertified = data.terms.filter((term) => !term.certified).length;
  return (
    <CanWriteContext.Provider value={data.canWrite}>
      <div className="space-y-6" data-semantic-state="ready">
        <p className="text-muted-foreground text-sm">
          {`${data.terms.length} terms, ${uncertified} not certified. The assistant answers only certified terms; editing anything removes its certification.`}
        </p>
        {notice === null ? null : (
          <p
            className={
              notice.tone === "error" ? "text-destructive text-sm" : "text-sm"
            }
            data-notice={notice.tone}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}
        {data.terms.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The catalog has no terms.
          </p>
        ) : (
          data.terms.map((term) => (
            <TermView
              attributes={data.attributes.filter(
                (attribute) => attribute.termId === term.id
              )}
              key={term.id}
              pending={pending}
              term={term}
              write={write}
            />
          ))
        )}
        <RelationshipsTable
          pending={pending}
          relationships={data.relationships}
          write={write}
        />
      </div>
    </CanWriteContext.Provider>
  );
};
