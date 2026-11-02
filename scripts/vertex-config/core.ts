import { parseEnv } from "node:util";

export class ConfigurationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ConfigurationError";
  }
}

export type Assignment = Readonly<{ name: string; value: string }>;
export type Source = Readonly<{ label: string; content: string }>;
export type Values = Readonly<Record<string, string>>;
export type Projection = Readonly<{
  environment: string;
  service: string;
  names: readonly string[];
}>;
export type InventoryEntry = Readonly<{
  name: string;
  status:
    | "selected"
    | "conflict"
    | "empty"
    | "ineligible"
    | "schema-gap"
    | "excluded";
  sources: readonly string[];
  reference: boolean;
  present: boolean;
  equality: "absent" | "unique" | "identical" | "conflicting";
}>;

// Exact names only. Never infer that an SSH host is a provider API URL.
export const authorizedNames: readonly string[] = [
  "QUANTDATA_API_BASE_URL",
  "QUANTDATA_API_KEY",
  "FINANCIAL_DATASETS_API_BASE_URL",
  "FINANCIAL_DATASETS_API_KEY",
  "QUANT_VPS_API_URL",
  "QUANT_VPS_API_TOKEN",
  "IBKR_HOST",
  "IBKR_PORT",
  "IBKR_CLIENT_ID",
  "IBKR_ACCOUNT_ID",
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "CONTACT_EMAIL_TO",
  "NTFY_SERVER_URL",
  "NTFY_TOPIC",
  "NTFY_ACCESS_TOKEN",
  "NOTIFICATION_EMAIL_TO",
  "AGNO_API_URL",
  "AGNO_API_TOKEN",
  "JEV_API_URL",
  "JEV_API_TOKEN",
  "JEV_ALLOWED_ORIGINS",
];

const unsupportedNames = new Set([
  "QUANTVPS_HOST",
  "QUANTVPS_SSH_HOST",
  "QUANTVPS_SSH_PORT",
  "QUANTVPS_SSH_USER",
  "QUANTVPS_SSH_KEY_REF",
  "IBKR_USERNAME",
  "IBKR_PASSWORD",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "PLANETSCALE_SERVICE_TOKEN",
  "PLANETSCALE_SERVICE_TOKEN_ID",
  "PLANETSCALE_DATABASE_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "AGNO_API_KEY",
  "JEV_API_KEY",
]);
const excludedNames = new Set([
  "QUANTVPS_SSH_PASSWORD",
  "IBKR_TRADING_MODE",
  "IBKR_READ_ONLY",
  "NAUTILUS_TRADING_MODE",
]);
const aliases: Readonly<Record<string, string>> = {
  IB_GATEWAY_HOST: "IBKR_HOST",
  IB_GATEWAY_PORT: "IBKR_PORT",
};
const provenance =
  /^(?:gamma-forge|vertex-quant|vertex-research|full-port|darkfactory)\/\.env(?:\.schema|\.example)?$/;
const masterLabel = "private/configuration/.env";

export const parseAssignments = (content: string): Assignment[] => {
  if (
    content.includes("\0") ||
    Buffer.byteLength(content, "utf8") > 1024 * 1024
  ) {
    throw new ConfigurationError("invalid-dotenv");
  }
  const text = content.replace(/^\uFEFF/, "");
  const entries: Assignment[] = [];
  let position = 0;
  while (position < text.length) {
    const blank = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
    blank.lastIndex = position;
    const skipped = blank.exec(text);
    if (skipped && skipped[0].length > 0) {
      position = blank.lastIndex;
      continue;
    }
    const header =
      /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/y;
    header.lastIndex = position;
    const matched = header.exec(text);
    if (!matched) {
      throw new ConfigurationError("invalid-dotenv");
    }
    const start = position;
    position = header.lastIndex;
    const quote = text[position];
    if (quote === "'" || quote === '"' || quote === "`") {
      position += 1;
      let closed = false;
      while (position < text.length) {
        if (text[position] === quote) {
          position += 1;
          closed = true;
          break;
        }
        if (text[position] === "\\" && quote === '"') {
          position += 1;
        }
        position += 1;
      }
      if (!closed) {
        throw new ConfigurationError("invalid-dotenv");
      }
    } else {
      while (position < text.length && !/[#\r\n]/.test(text.charAt(position))) {
        position += 1;
      }
    }
    const ending = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
    ending.lastIndex = position;
    if (!ending.exec(text)) {
      throw new ConfigurationError("invalid-dotenv");
    }
    position = ending.lastIndex;
    try {
      const parsed = parseEnv(text.slice(start, position));
      const name = String(matched[1]);
      const value = parsed[name];
      if (Object.keys(parsed).length !== 1 || typeof value !== "string") {
        throw new ConfigurationError("invalid-dotenv");
      }
      entries.push({ name, value });
    } catch {
      throw new ConfigurationError("invalid-dotenv");
    }
  }
  return entries;
};

const isReference = (value: string): boolean => value.startsWith("op://");
const eligible = (name: string, value: string, label: string): boolean => {
  if (!value.trim()) return false;
  if (isReference(value)) return /^op:\/\/[^\s/]+\/[^\s/]+\/.+/.test(value);
  if (!label.endsWith("/.env")) return false;
  if (
    /^(?:your[_ -]|replace[_ -]|changeme|change-me|example|placeholder|dummy|test[_ -])/i.test(
      value
    )
  )
    return false;
  if (name === "DATABASE_URL") {
    try {
      const url = new URL(value);
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        url.hostname.endsWith(".pg.psdb.cloud")
      );
    } catch {
      return false;
    }
  }
  return true;
};

export const inventory = (
  schema: string,
  sources: readonly Source[],
  existing: string | null = null
) => {
  const schemaNames = new Set(
    parseAssignments(schema).map((entry) => entry.name)
  );
  const groups = new Map<
    string,
    { value: string; source: string; accepted: boolean }[]
  >();
  const statuses = new Map<string, InventoryEntry["status"]>();
  const rejectedSources: string[] = [];
  const allSources: Source[] = [...sources];
  if (existing !== null)
    allSources.push({ label: masterLabel, content: existing });
  let blocked = false;
  for (const source of allSources) {
    if (source.label !== masterLabel && !provenance.test(source.label)) {
      throw new ConfigurationError("invalid-source");
    }
    let entries: Assignment[];
    try {
      entries = parseAssignments(source.content);
    } catch {
      if (source.label === masterLabel)
        throw new ConfigurationError("invalid-master");
      rejectedSources.push(source.label);
      blocked = true;
      continue;
    }
    for (const entry of entries) {
      const name =
        (Object.hasOwn(aliases, entry.name)
          ? aliases[entry.name]
          : undefined) ?? entry.name;
      const authorized = authorizedNames.includes(name);
      if (
        source.label === masterLabel &&
        !(authorized && schemaNames.has(name))
      ) {
        throw new ConfigurationError("invalid-master");
      }
      if (
        !(authorized || unsupportedNames.has(name) || excludedNames.has(name))
      )
        continue;
      const accepted =
        authorized &&
        schemaNames.has(name) &&
        eligible(name, entry.value, source.label);
      if (source.label === masterLabel && !accepted)
        throw new ConfigurationError("invalid-master");
      if (excludedNames.has(name)) {
        statuses.set(name, "excluded");
      } else if (!(authorized && schemaNames.has(name)))
        statuses.set(name, "schema-gap");
      const group = groups.get(name) ?? [];
      group.push({ value: entry.value, source: source.label, accepted });
      groups.set(name, group);
    }
  }
  const selected: Record<string, string> = Object.create(null);
  const entries: InventoryEntry[] = [];
  for (const [name, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const accepted = group.filter((entry) => entry.accepted);
    const values = new Set(accepted.map((entry) => entry.value));
    const conflict = values.size > 1;
    const status =
      statuses.get(name) ??
      (conflict
        ? "conflict"
        : values.size === 1
          ? "selected"
          : group.some((entry) => entry.value.length > 0)
            ? "ineligible"
            : "empty");
    if (conflict && group.some((entry) => entry.source === masterLabel))
      blocked = true;
    const [first] = accepted;
    if (status === "selected" && first) selected[name] = first.value;
    const candidates = group.filter(
      (entry) =>
        entry.value.trim() &&
        (entry.source.endsWith("/.env") || isReference(entry.value))
    );
    const distinct = new Set(candidates.map((entry) => entry.value));
    const equality =
      candidates.length === 0
        ? "absent"
        : distinct.size > 1
          ? "conflicting"
          : candidates.length > 1
            ? "identical"
            : "unique";
    entries.push({
      name,
      status,
      sources: [...new Set(group.map((entry) => entry.source))].sort(),
      reference: candidates.some((entry) => isReference(entry.value)),
      present: candidates.length > 0,
      equality,
    });
  }
  const absentNames = authorizedNames
    .filter((name) => !groups.has(name))
    .sort();
  return {
    selected,
    blocked,
    report: {
      entries,
      absentNames,
      rejectedSources: [...new Set(rejectedSources)].sort(),
      validation: "not-performed" as const,
    },
  };
};

const safetyDefaults: Values = {
  VERTEX_MODE: "research",
  VERTEX_ACCESS_MODE: "read-only",
  VERTEX_ORDER_SUBMISSION: "disabled",
  IBKR_RUNTIME_STATE: "disabled",
  IBKR_TRADING_MODE: "paper",
  IBKR_READ_ONLY: "true",
  IBKR_RECOVERY_POLICY: "human-trigger-only",
  NAUTILUS_RUNTIME_STATE: "disabled",
  NAUTILUS_TRADING_MODE: "paper",
  QUANT_RUNTIME_STATE: "disabled",
  MARKET_DATA_RUNTIME_STATE: "disabled",
  RESEARCH_RUNTIME_STATE: "disabled",
  AGNO_RUNTIME_STATE: "disabled",
  RUST_KERNEL_RUNTIME_STATE: "disabled",
  NOTIFICATION_RUNTIME_STATE: "disabled",
  NOTIFICATION_PROVIDER: "disabled",
  JEV_RUNTIME_STATE: "disabled",
  EMAIL_TRANSPORT: "preview",
  STORAGE_ENABLED: "false",
  OTEL_ENABLED: "false",
};
const dataNames = [
  "QUANTDATA_API_BASE_URL",
  "QUANTDATA_API_KEY",
  "FINANCIAL_DATASETS_API_BASE_URL",
  "FINANCIAL_DATASETS_API_KEY",
];
const services: Readonly<Record<string, readonly string[]>> = {
  browser: [],
  research: dataNames,
  "market-data": dataNames,
  agno: ["AGNO_API_URL", "AGNO_API_TOKEN"],
  jev: ["JEV_API_URL", "JEV_API_TOKEN", "JEV_ALLOWED_ORIGINS"],
};

export const project = (
  bundle: Values,
  selection: Projection
): Record<string, string> => {
  if (!["development", "test"].includes(selection.environment)) {
    throw new ConfigurationError("invalid-environment");
  }
  const allowed = Object.hasOwn(services, selection.service)
    ? services[selection.service]
    : undefined;
  if (allowed === undefined) {
    throw new ConfigurationError("forbidden-service");
  }
  const result: Record<string, string> = {
    ...safetyDefaults,
    APP_ENV: selection.environment,
  };
  for (const name of selection.names) {
    if (!allowed.includes(name)) throw new ConfigurationError("forbidden-key");
    const value = Object.hasOwn(bundle, name) ? bundle[name] : undefined;
    if (!value?.trim()) throw new ConfigurationError("missing-key");
    result[name] = value;
  }
  return result;
};

export const localDefaults = (): Record<string, string> => ({
  ...safetyDefaults,
  APP_ENV: "development",
  APP_NAME: "Vertex Research",
  APP_URL: "https://darkfactory.localhost",
  BETTER_AUTH_URL: "https://darkfactory.localhost",
  DATABASE_PROVIDER: "postgres",
  DATABASE_URL: "",
  BETTER_AUTH_SECRET: "vertex-local-development-only-not-a-production-secret",
  CONTACT_THROTTLE_SECRET:
    "vertex-local-development-only-contact-throttle-secret",
  AI_PROVIDER: "groq",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "Vertex Research <noreply@domain.test>",
  ANALYTICS_PROVIDER: "posthog",
  POSTHOG_KEY: "",
  OTEL_SERVICE_NAME: "darkfactory-web",
  CHART_RUNTIME_STATE: "disabled",
  CHART_RENDERER: "tanstack-charts-alpha",
});

export const serialize = (values: Values): string => {
  const allowed = new Set([
    ...authorizedNames,
    ...Object.keys(safetyDefaults),
    ...Object.keys(localDefaults()),
  ]);
  const lines: string[] = [];
  for (const [name, value] of Object.entries(values).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!allowed.has(name)) throw new ConfigurationError("unsupported-name");
    let encoded: string | undefined;
    for (const quote of ["'", '"', "`"]) {
      if (value.includes(quote)) continue;
      const candidate = `${name}=${quote}${value}${quote}\n`;
      try {
        if (parseAssignments(candidate)[0]?.value === value) {
          encoded = candidate;
          break;
        }
      } catch {
        // An unparseable candidate falls through to the next quote style.
      }
    }
    if (encoded === undefined)
      throw new ConfigurationError("unrepresentable-value");
    lines.push(encoded);
  }
  return lines.join("");
};
