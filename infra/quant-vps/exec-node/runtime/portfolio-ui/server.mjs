import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { buildPortfolio } from "./dist-server/portfolioData.js";
import { parseIbkrClientId } from "./serverUtils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.VERTEX_QUANT_REPO_ROOT || path.resolve(__dirname, "..");
const distDir = path.join(__dirname, "dist");
const reportsDir = path.join(repoRoot, "data", "nautilus", "reports");
const approvalsDir = path.join(repoRoot, "data", "nautilus", "approvals");
const marketSnapshotPath = path.join(repoRoot, "public", "data", "market-snapshot.json");
const openOrdersReportPath = path.join(reportsDir, "ibkr-open-orders.json");
const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || "127.0.0.1";
const password = process.env.PORTFOLIO_AUTH_PASSWORD || "";
const authUsername = process.env.PORTFOLIO_AUTH_USERNAME || "operator";
const execFileAsync = promisify(execFile);
let refreshInFlight = null;
let marketRefreshInFlight = null;
let openOrdersRefreshInFlight = null;
let twoFactorInFlight = null;
const cancelOrdersInFlight = new Set();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function unauthorized(res, realm = "Portfolio Command") {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`
  });
  res.end(JSON.stringify({ error: "Authentication required" }));
}

function passwordMatches(value) {
  if (!password) return false;
  const provided = Buffer.from(String(value ?? ""));
  const expected = Buffer.from(password);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function safeEqual(left, right) {
  const provided = Buffer.from(String(left ?? ""));
  const expected = Buffer.from(String(right ?? ""));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function basicAuthMatches(header) {
  if (!password || !String(header || "").startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(String(header).slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return safeEqual(decoded.slice(0, separator), authUsername) && safeEqual(decoded.slice(separator + 1), password);
  } catch {
    return false;
  }
}

function requireDashboardAuth(req, res) {
  if (basicAuthMatches(req.headers.authorization)) return true;
  unauthorized(res);
  return false;
}

function requirePasswordBody(body, res) {
  if (!passwordMatches(body?.password)) {
    unauthorized(res);
    return false;
  }
  return true;
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function latestReportFile(prefix) {
  try {
    return fs
      .readdirSync(reportsDir)
      .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
      .map((file) => path.join(reportsDir, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionKey(symbol, expiry, strike, right) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedExpiry = String(expiry ?? "").trim();
  const normalizedRight = String(right ?? "").trim().toUpperCase();
  const normalizedStrike = numberOrNull(strike);
  if (!normalizedSymbol || !normalizedExpiry || !normalizedRight || !normalizedStrike) return "";
  return `${normalizedSymbol}:${normalizedExpiry}:${normalizedStrike}:${normalizedRight}`;
}

function positionKey(position) {
  const symbol = String(position?.symbol ?? "").trim().toUpperCase();
  const secType = String(position?.sec_type ?? "").trim().toUpperCase();
  const contract = typeof position?.contract === "object" && position.contract ? position.contract : {};
  if (secType === "OPT") {
    return `OPT:${optionKey(
      symbol,
      contract.lastTradeDateOrContractMonth,
      contract.strike,
      contract.right
    )}`;
  }
  return `${secType || "STK"}:${symbol}`;
}

function activePositionMarketKeys() {
  const snapshotFile = latestReportFile("ibkr-account-snapshot-");
  const snapshot = snapshotFile ? readJsonSync(snapshotFile) : null;
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const stocks = new Set();
  const options = new Set();
  for (const position of positions) {
    const quantity = numberOrNull(position?.quantity);
    if (quantity === null || quantity === 0) continue;
    const symbol = String(position?.symbol || position?.contract?.symbol || "").trim().toUpperCase();
    if (symbol) stocks.add(symbol);
    const key = positionKey(position);
    if (key.startsWith("OPT:")) options.add(key.slice(4));
  }
  return { stocks, options };
}

function quoteHasPrice(quote) {
  return (
    numberOrNull(quote?.price) !== null ||
    numberOrNull(quote?.lastPrice) !== null ||
    numberOrNull(quote?.bid) !== null ||
    numberOrNull(quote?.ask) !== null
  );
}

function marketSnapshotNeedsRefresh() {
  const ttlSeconds = Number(process.env.PORTFOLIO_MARKET_REFRESH_TTL_SECONDS || 60);
  let stats;
  try {
    stats = fs.statSync(marketSnapshotPath);
  } catch {
    return true;
  }
  if (ttlSeconds > 0 && Date.now() - stats.mtimeMs > ttlSeconds * 1000) return true;
  const market = readJsonSync(marketSnapshotPath);
  const { stocks, options } = activePositionMarketKeys();
  for (const symbol of stocks) {
    if (!quoteHasPrice(market?.stocks?.[symbol])) return true;
  }
  for (const key of options) {
    if (!quoteHasPrice(market?.options?.[key])) return true;
  }
  return false;
}

function safeStaticPath(urlPath) {
  let requested;
  try {
    requested = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const resolved = path.resolve(distDir, "." + requested);
  const relative = path.relative(distDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizedMode(value) {
  return String(value || "").trim().toLowerCase();
}

function killSwitchActive() {
  const configured = process.env.KILL_SWITCH_PATH || path.join(repoRoot, "data", "KILL_SWITCH");
  const killSwitchPath = path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  return fs.existsSync(killSwitchPath);
}

function liveCancelSafetyError() {
  const ibkrMode = normalizedMode(process.env.IBKR_TRADING_MODE);
  const tradingMode = normalizedMode(process.env.TRADING_MODE);
  if (!ibkrMode || !tradingMode) return "IBKR_TRADING_MODE and TRADING_MODE are required";
  const modes = [ibkrMode, tradingMode];
  if (modes.some((mode) => !["paper", "live"].includes(mode))) return "IBKR_TRADING_MODE/TRADING_MODE must be paper or live";
  if (ibkrMode !== tradingMode) return "IBKR_TRADING_MODE and TRADING_MODE must match";
  if (!modes.includes("live")) return null;
  const accountId = String(process.env.IBKR_ACCOUNT_ID || "").trim();
  const allowlist = String(process.env.LIVE_TRADING_ACCOUNT_ALLOWLIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!parseBool(process.env.PORTFOLIO_ENABLE_LIVE_ORDER_CANCEL, false)) return "PORTFOLIO_ENABLE_LIVE_ORDER_CANCEL=true is required";
  if (!parseBool(process.env.ENABLE_LIVE_TRADING, false)) return "ENABLE_LIVE_TRADING=true is required";
  if (!parseBool(process.env.I_UNDERSTAND_LIVE_TRADING_RISK, false)) return "I_UNDERSTAND_LIVE_TRADING_RISK=true is required";
  if (!accountId) return "IBKR_ACCOUNT_ID is required";
  if (!allowlist.includes(accountId)) return "IBKR_ACCOUNT_ID must match LIVE_TRADING_ACCOUNT_ALLOWLIST";
  if (killSwitchActive()) return "kill switch is active";
  return null;
}

function sanitizeDetail(value) {
  const accountId = process.env.IBKR_ACCOUNT_ID || "";
  let detail = String(value || "").trim();
  if (accountId) detail = detail.replaceAll(accountId, "****");
  return detail.replace(/\bU\d{4,}\b/g, "U***").slice(0, 240);
}

async function submitClosePosition(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: sanitizeDetail(err?.message || "Invalid JSON body") });
    return;
  }
  if (!passwordMatches(body.password)) {
    unauthorized(res);
    return;
  }
  const requestedKey = String(body.position_key ?? "");
  if (!requestedKey) {
    jsonResponse(res, 400, { error: "position_key is required" });
    return;
  }
  const snapshotFile = latestReportFile("ibkr-account-snapshot-");
  if (!snapshotFile) {
    jsonResponse(res, 503, { error: "No IBKR snapshot is available" });
    return;
  }
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  const position = positions.find((row) => positionKey(row) === requestedKey);
  const quantity = numberOrNull(position?.quantity);
  if (!position || quantity === null || quantity <= 0) {
    jsonResponse(res, 409, { error: "Position is not open in the latest IBKR snapshot" });
    return;
  }
  const contract = typeof position.contract === "object" && position.contract ? position.contract : {};
  const secType = String(position.sec_type || contract.secType || "STK").toUpperCase();
  const symbol = String(position.symbol || contract.symbol || "").toUpperCase();
  const now = new Date().toISOString();
  const idempotencyKey = `vertex-ui-close:${requestedKey}:${Date.now()}`;
  const draft = {
    source: "VERTEX_UI",
    symbol,
    action: "SELL",
    quantity,
    estimated_notional_usd: Math.round(quantity * Number(position.average_cost || 0) * 100) / 100,
    order_type: "MKT",
    time_in_force: "DAY",
    sec_type: secType,
    asset_class: secType === "OPT" ? "option" : "equity",
    contract: {
      symbol,
      secType,
      exchange: contract.exchange || "SMART",
      currency: contract.currency || position.currency || "USD",
      lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth || "",
      strike: contract.strike || 0,
      right: contract.right || "",
      multiplier: contract.multiplier || ""
    },
    observed_at: now,
    idempotency_key: idempotencyKey
  };
  const approvalPath = path.join(approvalsDir, `vertex-ui-close-${Date.now()}.json`);
  await mkdir(approvalsDir, { recursive: true });
  await writeFile(
    approvalPath,
    JSON.stringify(
      {
        mode: "approved_for_manual_review_only_no_ibkr_submit",
        approved_at: now,
        operator: "portfolio-ui",
        draft_count: 1,
        drafts: [draft]
      },
      null,
      2
    ) + "\n",
    { encoding: "utf8", mode: 0o600 }
  );
  try {
    const { stdout } = await execFileAsync(
      process.env.PORTFOLIO_SNAPSHOT_PYTHON || "/opt/ibkr-snapshot-venv/bin/python3",
      [
        path.join(repoRoot, "scripts", "position_close.py"),
        approvalPath,
        "--account-snapshot",
        snapshotFile,
        "--env-file",
        path.join(repoRoot, ".env"),
        "--operator",
        "portfolio-ui",
        "--enable-live-transmit",
        "--i-understand-this-places-real-orders",
        "--extra-approved-source",
        "VERTEX_UI",
        "--client-id",
        String(process.env.PORTFOLIO_CLOSE_IBKR_CLIENT_ID || 52),
      ],
      {
        cwd: repoRoot,
        timeout: Number(process.env.PORTFOLIO_CLOSE_TIMEOUT_SECONDS || 15) * 1000,
        maxBuffer: 1024 * 1024
      }
    );
    jsonResponse(res, 200, {
      status: "submitted",
      position_key: requestedKey,
      approval: path.relative(repoRoot, approvalPath),
      result: JSON.parse(stdout || "{}")
    });
  } catch (err) {
    jsonResponse(res, 500, {
      error: "Close order submit failed",
      detail: sanitizeDetail(err?.stderr || err?.stdout || err?.message || "unknown")
    });
  }
}

async function runOpenOrdersRefresh() {
  if (!parseBool(process.env.PORTFOLIO_OPEN_ORDERS_REFRESH_ON_LOAD, true)) {
    return {
      requested: false,
      checked_at: new Date().toISOString(),
      status: "disabled",
      detail: "Open orders refresh is disabled"
    };
  }
  if (openOrdersRefreshInFlight) return openOrdersRefreshInFlight;
  openOrdersRefreshInFlight = (async () => {
    const checkedAt = new Date().toISOString();
    const timeoutSeconds = Number(process.env.PORTFOLIO_OPEN_ORDERS_TIMEOUT_SECONDS || 15);
    const args = [
      path.join(repoRoot, "scripts", "ibkr_open_orders.py"),
      "--env-file",
      path.join(repoRoot, ".env"),
      "--host",
      process.env.IB_GATEWAY_HOST || process.env.IBKR_HOST || "127.0.0.1",
      "--port",
      String(process.env.IB_GATEWAY_PORT || process.env.IBKR_PORT || 4002),
      "--client-id",
      String(process.env.PORTFOLIO_OPEN_ORDERS_CLIENT_ID || process.env.IBKR_OPEN_ORDERS_CLIENT_ID || 49),
      "--timeout-seconds",
      String(timeoutSeconds),
      "--output",
      openOrdersReportPath
    ];
    try {
      const { stdout } = await execFileAsync(
        process.env.PORTFOLIO_SNAPSHOT_PYTHON || "/opt/ibkr-snapshot-venv/bin/python3",
        args,
        {
          cwd: repoRoot,
          timeout: Math.max(1, timeoutSeconds + 5) * 1000,
          maxBuffer: 1024 * 1024
        }
      );
      const payload = JSON.parse(stdout || "{}");
      return {
        requested: true,
        checked_at: checkedAt,
        status: "success",
        detail: `${payload.open_orders ?? 0} open orders`
      };
    } catch (err) {
      return {
        requested: true,
        checked_at: checkedAt,
        status: "failed",
        detail: sanitizeDetail(err?.stderr || err?.stdout || err?.message || "Open orders refresh failed")
      };
    } finally {
      openOrdersRefreshInFlight = null;
    }
  })();
  return openOrdersRefreshInFlight;
}

async function readOpenOrders(refresh) {
  const refreshInfo = refresh ? await runOpenOrdersRefresh() : null;
  const payload = readJsonSync(openOrdersReportPath) || { orders: [], open_orders: 0 };
  return {
    ...payload,
    refresh: refreshInfo
  };
}

async function submitCancelOrder(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: sanitizeDetail(err?.message || "Invalid JSON body") });
    return;
  }
  if (!requirePasswordBody(body, res)) return;
  const orderId = Number(body.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    jsonResponse(res, 400, { error: "order_id is required" });
    return;
  }
  const safetyError = liveCancelSafetyError();
  if (safetyError) {
    jsonResponse(res, 403, { error: safetyError });
    return;
  }
  const openOrdersPayload = readJsonSync(openOrdersReportPath) || { orders: [] };
  const order = Array.isArray(openOrdersPayload.orders)
    ? openOrdersPayload.orders.find((entry) => Number(entry?.order_id) === orderId)
    : null;
  const clientId = parseIbkrClientId(order?.client_id);
  if (clientId === null) {
    jsonResponse(res, 409, { error: "Order is missing IBKR client_id; refresh open orders before canceling" });
    return;
  }
  const timeoutSeconds = Number(process.env.PORTFOLIO_CANCEL_ORDER_TIMEOUT_SECONDS || 15);
  const args = [
    path.join(repoRoot, "scripts", "ibkr_cancel_order.py"),
    "--order-id",
    String(orderId),
    "--env-file",
    path.join(repoRoot, ".env"),
    "--host",
    process.env.IB_GATEWAY_HOST || process.env.IBKR_HOST || "127.0.0.1",
    "--port",
    String(process.env.IB_GATEWAY_PORT || process.env.IBKR_PORT || 4002),
    "--client-id",
    String(clientId),
    "--timeout-seconds",
    String(timeoutSeconds),
    "--expected-json",
    JSON.stringify(order)
  ];
  const accountId = String(process.env.IBKR_ACCOUNT_ID || "").trim();
  if (accountId) args.push("--account-id", accountId);
  if (cancelOrdersInFlight.has(orderId)) {
    jsonResponse(res, 409, { error: "Cancel already in flight for this order" });
    return;
  }
  cancelOrdersInFlight.add(orderId);
  try {
    const { stdout } = await execFileAsync(
      process.env.PORTFOLIO_SNAPSHOT_PYTHON || "/opt/ibkr-snapshot-venv/bin/python3",
      args,
      {
        cwd: repoRoot,
        timeout: Math.max(1, timeoutSeconds + 5) * 1000,
        maxBuffer: 1024 * 1024
      }
    );
    const cancel = JSON.parse(stdout || "{}");
    const openOrders = await runOpenOrdersRefresh();
    jsonResponse(res, 200, {
      status: "success",
      cancel,
      open_orders_refresh: openOrders
    });
  } catch (err) {
    console.error("IBKR cancel order failed:", sanitizeDetail(err?.stderr || err?.stdout || err?.message || "Cancel order failed"));
    jsonResponse(res, 500, {
      status: "failed",
      error: "Cancel order failed; check server logs"
    });
  } finally {
    cancelOrdersInFlight.delete(orderId);
  }
}

async function runSnapshotRefresh() {
  if (!parseBool(process.env.PORTFOLIO_SNAPSHOT_REFRESH_ON_LOAD, true)) {
    const marketRefresh = await runMarketRefresh();
    return {
      requested: false,
      checked_at: new Date().toISOString(),
      status: "disabled",
      detail: `Broker refresh is disabled; market ${marketRefresh.status}: ${marketRefresh.detail}`
    };
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const checkedAt = new Date().toISOString();
    const timeoutSeconds = Number(process.env.PORTFOLIO_SNAPSHOT_TIMEOUT_SECONDS || 20);
    const args = [
      path.join(repoRoot, "scripts", "ibkr_account_snapshot.py"),
      "--env-file",
      path.join(repoRoot, ".env"),
      "--host",
      process.env.IB_GATEWAY_HOST || process.env.IBKR_HOST || "127.0.0.1",
      "--port",
      String(process.env.IB_GATEWAY_PORT || process.env.IBKR_PORT || 4002),
      "--client-id",
      String(process.env.PORTFOLIO_IBKR_CLIENT_ID || 31),
      "--timeout-seconds",
      String(timeoutSeconds),
      "--output-dir",
      path.join(repoRoot, "data", "nautilus", "reports")
    ];
    const fillArgs = [
      path.join(repoRoot, "scripts", "ibkr_fill_check.py"),
      "--env-file",
      path.join(repoRoot, ".env"),
      "--host",
      process.env.IB_GATEWAY_HOST || process.env.IBKR_HOST || "127.0.0.1",
      "--port",
      String(process.env.IB_GATEWAY_PORT || process.env.IBKR_PORT || 4002),
      "--client-id",
      String(process.env.IBKR_FILL_CHECK_CLIENT_ID || 45),
      "--timeout-seconds",
      String(Math.min(timeoutSeconds, 10)),
      "--output",
      path.join(repoRoot, "data", "nautilus", "reports", "ibkr-fills.json")
    ];
    try {
      const { stdout } = await execFileAsync(
        process.env.PORTFOLIO_SNAPSHOT_PYTHON || "/opt/ibkr-snapshot-venv/bin/python3",
        args,
        {
        cwd: repoRoot,
        timeout: Math.max(1, timeoutSeconds + 5) * 1000,
        maxBuffer: 1024 * 1024
        }
      );
      const payload = JSON.parse(stdout || "{}");
      let fillDetail = "fills not refreshed";
      try {
        const { stdout: fillStdout } = await execFileAsync(
          process.env.PORTFOLIO_SNAPSHOT_PYTHON || "/opt/ibkr-snapshot-venv/bin/python3",
          fillArgs,
          {
            cwd: repoRoot,
            timeout: Math.max(1, Math.min(timeoutSeconds, 10) + 5) * 1000,
            maxBuffer: 1024 * 1024
          }
        );
        const fillPayload = JSON.parse(fillStdout || "{}");
        fillDetail = `${fillPayload.executions ?? 0} executions`;
      } catch (fillErr) {
        fillDetail = `fill refresh failed: ${sanitizeDetail(fillErr?.stderr || fillErr?.stdout || fillErr?.message || "unknown")}`;
      }
      const openOrdersRefresh = await runOpenOrdersRefresh();
      const marketRefresh = await runMarketRefresh();
      return {
        requested: true,
        checked_at: checkedAt,
        status: "success",
        detail: `${payload.positions ?? 0} positions, available funds ${payload.available_funds_usd ?? "n/a"}; ${fillDetail}; open orders ${openOrdersRefresh.status}: ${openOrdersRefresh.detail}; market ${marketRefresh.status}: ${marketRefresh.detail}`
      };
    } catch (err) {
      const marketRefresh = await runMarketRefresh();
      return {
        requested: true,
        checked_at: checkedAt,
        status: "failed",
        detail: `${sanitizeDetail(err?.stderr || err?.stdout || err?.message || "Snapshot refresh failed")}; market ${marketRefresh.status}: ${marketRefresh.detail}`
      };
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function runMarketRefresh() {
  if (!parseBool(process.env.PORTFOLIO_MARKET_REFRESH_ON_LOAD, true)) {
    return {
      requested: false,
      status: "disabled",
      detail: "Market refresh is disabled"
    };
  }
  if (!marketSnapshotNeedsRefresh()) {
    return {
      requested: false,
      status: "skipped",
      detail: "Market data is fresh"
    };
  }
  if (marketRefreshInFlight) return marketRefreshInFlight;
  marketRefreshInFlight = (async () => {
    const timeoutSeconds = Number(process.env.PORTFOLIO_MARKET_REFRESH_TIMEOUT_SECONDS || 30);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", path.join(repoRoot, "src", "update-market-data.ts")],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            MARKET_REFRESH_HISTORY: "false"
          },
          timeout: Math.max(1, timeoutSeconds) * 1000,
          maxBuffer: 1024 * 1024
        }
      );
      return {
        requested: true,
        status: "success",
        detail: sanitizeDetail(stdout || "market data refreshed")
      };
    } catch (err) {
      return {
        requested: true,
        status: "failed",
        detail: sanitizeDetail(err?.stderr || err?.stdout || err?.message || "Market refresh failed")
      };
    } finally {
      marketRefreshInFlight = null;
    }
  })();
  return marketRefreshInFlight;
}

async function requestIbkrTwoFactor() {
  if (twoFactorInFlight) return twoFactorInFlight;
  twoFactorInFlight = (async () => {
    const checkedAt = new Date().toISOString();
    const approvalTimeout = Number(process.env.IBKR_2FA_UI_APPROVAL_TIMEOUT_SECONDS || 180);
    try {
      const { stdout } = await execFileAsync(
        "bash",
        [path.join(repoRoot, "scripts", "request-ibkr-2fa-until-ready.sh")],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            IBKR_2FA_NOTIFY_ENABLED: process.env.IBKR_2FA_UI_NOTIFY_ENABLED || "0",
            IBKR_2FA_APPROVAL_TIMEOUT_SECONDS: String(approvalTimeout),
            IBKR_2FA_SKIP_LOAD_ENV: "1"
          },
          timeout: Math.max(1, approvalTimeout + 30) * 1000,
          maxBuffer: 4 * 1024 * 1024
        }
      );
      const tail = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join("; ");
      return {
        status: "success",
        checked_at: checkedAt,
        detail: sanitizeDetail(tail || "IBKR Gateway reconnected"),
        rescan_requested: false
      };
    } catch (err) {
      return {
        status: "failed",
        checked_at: checkedAt,
        detail: sanitizeDetail(
          (err && (err.stderr || err.stdout || err.message)) || "IBKR 2FA request failed"
        )
      };
    } finally {
      twoFactorInFlight = null;
    }
  })();
  return twoFactorInFlight;
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (!requireDashboardAuth(req, res)) return;
  if (url.pathname === "/api/portfolio") {
    const refreshInfo = null;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(buildPortfolio(refreshInfo)));
    return;
  }

  if (url.pathname === "/api/portfolio-refresh") {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "POST required" });
      return;
    }
    const refreshInfo = await runSnapshotRefresh();
    jsonResponse(res, 200, {
      refresh: refreshInfo,
      portfolio: buildPortfolio(refreshInfo)
    });
    return;
  }

  if (url.pathname === "/api/ibkr-open-orders") {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "POST required" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      jsonResponse(res, 400, { error: sanitizeDetail(err?.message || "Invalid JSON body") });
      return;
    }
    if (!requirePasswordBody(body, res)) return;
    jsonResponse(res, 200, await readOpenOrders(parseBool(body.refresh, false)));
    return;
  }

  if (url.pathname === "/api/ibkr-order-cancel") {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "POST required" });
      return;
    }
    await submitCancelOrder(req, res);
    return;
  }

  if (url.pathname === "/api/position-close") {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "POST required" });
      return;
    }
    await submitClosePosition(req, res);
    return;
  }

  if (url.pathname === "/api/ibkr-2fa") {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "POST required" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      jsonResponse(res, 400, { error: sanitizeDetail(err?.message || "Invalid JSON body") });
      return;
    }
    if (!passwordMatches(body.password)) {
      unauthorized(res);
      return;
    }
    const result = await requestIbkrTwoFactor();
    jsonResponse(res, 200, result);
    return;
  }

  let filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    res.writeHead(404);
    res.end("Not found\n");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    filePath = path.join(distDir, "index.html");
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store" });
    res.end(body);
  }
}).listen(port, host, () => {
  console.log(`vertex portfolio listening on ${host}:${port}`);
});
