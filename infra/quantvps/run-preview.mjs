// QuantVPS production serve for vertex-web (audit P0-1). Replaces the development
// runner (`private/basic-app-named/run.mjs`, `vinext dev`): this runs `vite preview`
// on the prebuilt Worker (apps/web/dist, from `vinext build`), so there is no Vite
// error overlay, no HMR socket and no /@fs asset path.
//
// Route: browser -> vertex-web-tailnet Caddy (https://quant-vps-host.example-tailnet.ts.net:3451,
// keeps Host, sets X-Forwarded-Proto: https, rejects foreign Origin) -> 127.0.0.1:3450.
// APP_URL and BETTER_AUTH_URL are that tailnet origin, so auth links (password reset,
// verification) and same-origin checks use it.
//
// APP_ENV stays "development": packages/config rejects a loopback PostgreSQL host
// under APP_ENV=production (that rule is for Cloudflare Workers), and this host's
// database is the local container on 127.0.0.1:5433. The bundle itself is a
// production build (NODE_ENV=production).
//
// Bindings: private/basic-app-named/.prod.vars (owner-only, 0600). The runner
// validates it and writes it to apps/web/dist/server/.dev.vars (0600), where
// `vite preview` reads Worker bindings. The host environment is not forwarded.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = join(root, "private/basic-app-named");
const web = join(root, "apps/web");
const origin = "https://quant-vps-host.example-tailnet.ts.net:3451";
const logPath = join(directory, "runtime.log");

const privateRead = (path) => {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are combined as a bit mask.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.uid !== process.getuid() ||
      stats.nlink !== 1 ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits are extracted with a bit mask.
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 131_072
    ) {
      throw new Error("Private runtime file metadata is unsafe.");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

const bindingsText = privateRead(join(directory, ".prod.vars"));
const bindings = parseEnv(bindingsText);
const required = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "CONTACT_THROTTLE_SECRET",
];
const emailDisabled =
  bindings.EMAIL_PROVIDER === "disabled" &&
  bindings.EMAIL_TRANSPORT === "disabled";
// Real delivery through Resend (send-only key), with no local preview binding.
const emailResend =
  bindings.EMAIL_PROVIDER === "resend" &&
  bindings.EMAIL_TRANSPORT === "resend" &&
  /^re_[A-Za-z0-9_]{20,}$/u.test(bindings.RESEND_API_KEY ?? "") &&
  Boolean(bindings.EMAIL_FROM);
if (
  required.some((key) => !bindings[key]) ||
  bindings.APP_ENV !== "development" ||
  bindings.APP_URL !== origin ||
  bindings.BETTER_AUTH_URL !== origin ||
  bindings.DATABASE_PROVIDER !== "postgres" ||
  bindings.DEV_EMAIL_PREVIEW_ENDPOINT ||
  bindings.DEV_EMAIL_PREVIEW_KEY ||
  bindings.E2E_FIXTURES ||
  !(emailDisabled || emailResend)
) {
  throw new Error("QuantVPS production bindings are incomplete or unsafe.");
}
const databaseUrl = new URL(bindings.DATABASE_URL);
if (
  databaseUrl.hostname !== "127.0.0.1" ||
  databaseUrl.port !== "5433" ||
  databaseUrl.pathname !== "/vertex_research_development" ||
  databaseUrl.username !== "vertex_research"
) {
  throw new Error("Unexpected local database binding.");
}

const secretValues = [
  ...new Set([
    ...required.map((key) => bindings[key]),
    bindings.RESEND_API_KEY,
    bindings.OPENROUTER_API_KEY,
    bindings.VERTEX_DEPLOY_STATUS_TOKEN,
    databaseUrl.password,
    decodeURIComponent(databaseUrl.password),
  ]),
]
  .filter((value) => value && value.length >= 8)
  .sort((a, b) => b.length - a.length);
const scrub = (line) => {
  let text = line.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  for (const secret of secretValues)
    text = text.split(secret).join("[redacted]");
  text = text.replace(
    /(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s]*/giu,
    "[credential-bearing URL redacted]"
  );
  if (/(?:authorization|set-cookie|cookie)\s*[:=]/iu.test(text))
    return "[credential-bearing header redacted]";
  if (/-----BEGIN|-----END|PRIVATE KEY/iu.test(text))
    return "[certificate or key material redacted]";
  return text.slice(0, 16_384);
};
writeFileSync(logPath, "", { mode: 0o600 });
const emit = (text) => {
  const safe = scrub(text);
  appendFileSync(logPath, `${safe}\n`, { mode: 0o600 });
  process.stdout.write(`${safe}\n`);
};

// `vite preview` reads Worker bindings from the build output's .dev.vars. It finds
// the output config through apps/web/.wrangler/deploy/config.json, which
// `vinext build` writes; a deploy must copy that file together with dist/.
const outputBindings = join(web, "dist/server/.dev.vars");
for (const output of [
  "dist/server/wrangler.json",
  ".wrangler/deploy/config.json",
]) {
  if (!existsSync(join(web, output))) {
    emit(`VERTEX_WEB_PREVIEW_BUILD_MISSING ${output}`);
    throw new Error("The production build output is missing.");
  }
}
writeFileSync(outputBindings, bindingsText, { mode: 0o600, flag: "w" });

const environment = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(directory, "home"),
  XDG_CONFIG_HOME: join(directory, "config"),
  XDG_CACHE_HOME: join(directory, "cache"),
  TMPDIR: join(directory, "tmp"),
  LANG: "C.UTF-8",
  TZ: "UTC",
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: "3450",
  VERTEX_SELF_HOSTED_ORIGIN: origin,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_REGISTRY_PATH: join(directory, "registry"),
  MINIFLARE_REGISTRY_PATH: join(directory, "registry"),
  X_LOCAL_EXPLORER: "false",
  X_LOCAL_OBSERVABILITY: "false",
  NO_COLOR: "1",
  BROWSER: "none",
};
const child = spawn(
  process.execPath,
  [
    join(web, "node_modules/vite/bin/vite.js"),
    "preview",
    "--mode",
    "production",
  ],
  {
    cwd: web,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  }
);
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  let buffered = "";
  let privateBlock = false;
  stream.on("data", (data) => {
    buffered += data;
    let end = buffered.indexOf("\n");
    while (end >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.includes("-----BEGIN")) privateBlock = true;
      if (privateBlock) {
        if (line.includes("-----END")) privateBlock = false;
      } else {
        emit(line);
      }
      end = buffered.indexOf("\n");
    }
    if (buffered.length > 32_768) {
      buffered = "";
      emit("[oversize process-output line withheld]");
    }
  });
  stream.on("end", () => {
    if (buffered && !privateBlock) emit(buffered);
  });
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  emit("VERTEX_WEB_PREVIEW_START_FAILED");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  emit(
    `VERTEX_WEB_PREVIEW_EXIT code=${code ?? "none"} signal=${signal ?? "none"}`
  );
  process.exitCode = code ?? 1;
});
emit("VERTEX_WEB_PREVIEW_STARTING production-build loopback-only");
