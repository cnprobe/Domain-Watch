import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createDomainWatch } from "./domain-watch.mjs";
import { createMonitor, TelegramNotifier } from "./monitor.mjs";
import { SettingsStore, clearSessionCookie, fail, parseCookies, sessionCookie } from "./auth.mjs";

const rootDir = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || join(rootDir, "data"));
const publicFile = resolve(process.env.PUBLIC_FILE || join(rootDir, "admin.html"));
const monitorFile = resolve(process.env.MONITOR_PAGE_FILE || join(rootDir, "website/monitor.html"));
const loginFile = resolve(process.env.LOGIN_PAGE_FILE || join(rootDir, "website/login.html"));
const settingsFile = resolve(process.env.SETTINGS_PAGE_FILE || join(rootDir, "website/settings.html"));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
// 默认全站私有：只有 /login、/api/auth/login 和 /healthz 公开，查询页需要登录
const publicQuery = envBoolean(process.env.PUBLIC_QUERY, false);
const cookieSecure = envBoolean(process.env.COOKIE_SECURE, false);
const loginWindowMs = 15 * 60 * 1000;
const loginMaxFailures = 5;

function envBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on", "y"].includes(String(value).trim().toLowerCase());
}

function errorBody(error) {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
  return {
    ok: false,
    error: {
      code: error?.code || "unknown",
      message,
    },
  };
}

function sendJson(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function requestUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function bearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value === "string" && value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return typeof req.headers["x-admin-token"] === "string" ? req.headers["x-admin-token"].trim() : "";
}

function statusForError(code) {
  if (code === "not_found") return 404;
  if (code === "invalid_domain" || code === "invalid_argument") return 400;
  if (code === "unsupported_tld") return 422;
  return 502;
}

/** Telegram 发送失败时的状态码：未配置属于配置问题，上游失败或超时属于网关问题 */
function statusForNotifierError(code) {
  if (code === "telegram_not_configured") return 400;
  if (code === "telegram_timeout") return 504;
  if (code === "telegram_error" || code === "telegram_network_error") return 502;
  return 500;
}

const UPSTREAM_CODES = new Set([
  "telegram_error",
  "telegram_timeout",
  "telegram_network_error",
  "network_error",
  "timeout",
  "http_error",
  "rate_limited",
  "bootstrap_error",
]);

/** 手动检查的结果状态码：全部成功 200，只缺 Telegram 配置 400，上游失败 502，其余 500 */
function statusForCheckResult(result) {
  if (result?.ok) return 200;
  const codes = Array.isArray(result?.failedCodes) ? result.failedCodes : [];
  if (codes.length > 0 && codes.every((code) => code === "telegram_not_configured")) return 400;
  if (codes.some((code) => UPSTREAM_CODES.has(code))) return 502;
  return 500;
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求体过大");
      error.code = "payload_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是有效 JSON");
    error.code = "invalid_json";
    throw error;
  }
}

async function main() {
  await mkdir(dataDir, { recursive: true });

  const settingsStore = new SettingsStore({ dataDir });
  const { initialCredentials } = await settingsStore.init();
  if (initialCredentials) {
    const reason = initialCredentials.reason === "reset" ? "已重置" : "首次创建";
    console.log("[domain-watch] ================================================");
    console.log(`[domain-watch] 单用户账号${reason}：${initialCredentials.username}`);
    console.log(`[domain-watch] 初始密码：${initialCredentials.password}`);
    console.log("[domain-watch] 请登录后立即在设置页面修改密码；此密码只显示一次");
    console.log("[domain-watch] ================================================");
  }

  const config = {
    domains: process.env.DOMAINS || "",
    remindDays: process.env.REMIND_DAYS ?? 30,
    dailyRemind: envBoolean(process.env.DAILY_REMIND, true),
    backorderNotify: envBoolean(process.env.BACKORDER_NOTIFY, true),
    checkTime: process.env.CHECK_TIME || "09:00",
    runOnStartup: envBoolean(process.env.RUN_ON_STARTUP, false),
  };

  const domainWatch = createDomainWatch({ dataDir });
  const telegramConfig = await settingsStore.getTelegramConfig();
  const notifier = new TelegramNotifier(telegramConfig);
  const monitor = createMonitor({ config, domainWatch, notifier, dataDir });
  const legacyAdminToken = String(process.env.ADMIN_TOKEN || "").trim();
  const loginAttempts = new Map();
  let publicHtml = { value: null };
  let monitorHtml = { value: null };
  let loginHtml = { value: null };
  let settingsHtml = { value: null };

  if (legacyAdminToken) {
    console.warn("[domain-watch] ADMIN_TOKEN is deprecated; use the single-user login session instead");
  }

  async function readPage(cache, file) {
    if (cache.value === null) {
      try {
        cache.value = await readFile(file, "utf8");
      } catch (error) {
        throw fail("page_unavailable", `无法读取页面文件 ${file}: ${error.message}`, error);
      }
    }
    return cache.value;
  }

  async function getPublicHtml() {
    return readPage(publicHtml, publicFile);
  }

  async function getMonitorHtml() {
    return readPage(monitorHtml, monitorFile);
  }

  async function getLoginHtml() {
    return readPage(loginHtml, loginFile);
  }

  async function getSettingsHtml() {
    return readPage(settingsHtml, settingsFile);
  }

  function sessionFor(req) {
    const cookies = parseCookies(req.headers.cookie);
    return settingsStore.verifySession(cookies.dw_session);
  }

  function authFor(req) {
    const session = sessionFor(req);
    if (session) return { session };
    if (legacyAdminToken && tokenMatches(legacyAdminToken, bearerToken(req))) return { legacy: true };
    return null;
  }

  function requirePageAuth(req, res) {
    if (authFor(req)) return true;
    const next = encodeURIComponent(requestUrl(req).pathname + requestUrl(req).search);
    redirect(res, `/login?next=${next}`);
    return false;
  }

  function requireApiAuth(req, res) {
    const auth = authFor(req);
    if (auth) return auth;
    sendJson(res, 401, errorBody({ code: "unauthorized", message: "请先登录" }));
    return null;
  }

  function requireSameOriginForSession(req, res, auth) {
    if (auth?.session && !sameOrigin(req)) {
      sendJson(res, 403, errorBody({ code: "csrf_rejected", message: "请求来源不被允许" }));
      return false;
    }
    return true;
  }

  function loginAllowed(ip) {
    const record = loginAttempts.get(ip);
    if (!record || Date.now() - record.startedAt > loginWindowMs) {
      loginAttempts.delete(ip);
      return true;
    }
    return record.failures < loginMaxFailures;
  }

  function recordLoginFailure(ip) {
    const current = loginAttempts.get(ip);
    if (!current || Date.now() - current.startedAt > loginWindowMs) {
      loginAttempts.set(ip, { failures: 1, startedAt: Date.now() });
    } else {
      current.failures++;
    }
  }

  function clearLoginFailures(ip) {
    loginAttempts.delete(ip);
  }

  function cookieOptions(req, maxAge) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    return { secure: cookieSecure || forwardedProto === "https", maxAge };
  }

  async function handle(req, res) {
    const url = requestUrl(req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/login") {
      if (authFor(req)) {
        redirect(res, "/monitor");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await getLoginHtml());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const ip = clientIp(req);
      if (!loginAllowed(ip)) {
        sendJson(res, 429, errorBody({ code: "too_many_attempts", message: "登录失败次数过多，请稍后再试" }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const ok = await settingsStore.authenticate(body.username, body.password);
        if (!ok) {
          recordLoginFailure(ip);
          sendJson(res, 401, errorBody({ code: "invalid_credentials", message: "用户名或密码错误" }));
          return;
        }
        clearLoginFailures(ip);
        const session = settingsStore.createSession();
        res.setHeader("Set-Cookie", sessionCookie(session.token, cookieOptions(req, session.maxAge)));
        sendJson(res, 200, { ok: true, username: settingsStore.username, redirect: "/monitor" });
      } catch (error) {
        sendJson(res, error.code === "payload_too_large" ? 413 : 400, errorBody(error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      res.setHeader("Set-Cookie", clearSessionCookie(cookieOptions(req, 0)));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const auth = requireApiAuth(req, res);
      if (!auth) return;
      sendJson(res, 200, { ok: true, ...(await settingsStore.publicSettings()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/change-credentials") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);
        const result = await settingsStore.changeCredentials(body);
        res.setHeader("Set-Cookie", clearSessionCookie(cookieOptions(req, 0)));
        sendJson(res, 200, { ok: true, ...result, message: "账号已更新，请重新登录" });
      } catch (error) {
        sendJson(res, error?.code === "invalid_credentials" ? 403 : 400, errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/settings") {
      if (!requirePageAuth(req, res)) return;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await getSettingsHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      const auth = requireApiAuth(req, res);
      if (!auth) return;
      sendJson(res, 200, { ok: true, settings: await settingsStore.publicSettings(), monitor: monitor.status() });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/telegram") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);
        if (!(await settingsStore.authenticate(settingsStore.username, body.currentPassword))) {
          sendJson(res, 403, errorBody({ code: "invalid_credentials", message: "当前密码不正确" }));
          return;
        }
        const next = await settingsStore.setTelegram(body);
        notifier.update(next);
        sendJson(res, 200, { ok: true, settings: await settingsStore.publicSettings() });
      } catch (error) {
        sendJson(res, 400, errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!publicQuery && !requirePageAuth(req, res)) return;
      try {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(await getPublicHtml());
      } catch (error) {
        sendJson(res, 500, errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && (url.pathname === "/monitor" || url.pathname === "/monitor.html")) {
      if (!requirePageAuth(req, res)) return;
      try {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(await getMonitorHtml());
      } catch (error) {
        sendJson(res, 500, errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/monitor") {
      if (!requireApiAuth(req, res)) return;
      try {
        sendJson(res, 200, await monitor.snapshot());
      } catch (error) {
        sendJson(res, 500, errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && (url.pathname === "/api/whois" || url.pathname === "/api/plugin/whois")) {
      if (!publicQuery && !requireApiAuth(req, res)) return;
      try {
        const result = await domainWatch.queryDomain(url.searchParams.get("domain") || "");
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, statusForError(error?.code), errorBody(error));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      if (!requireApiAuth(req, res)) return;
      sendJson(res, 200, { ok: true, ...monitor.status() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/test-notify") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        await notifier.send("🧪 Domain Watch 测试通知", "这是一条来自 Domain Watch 独立网站的测试通知。");
        sendJson(res, 200, { ok: true, message: "测试通知已发送" });
      } catch (error) {
        sendJson(res, statusForNotifierError(error?.code), errorBody(error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/check") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const result = await monitor.check(url.searchParams.get("simulate") === "expired");
        sendJson(res, statusForCheckResult(result), result);
      } catch (error) {
        sendJson(res, 500, errorBody(error));
      }
      return;
    }

    sendJson(res, 404, errorBody({ code: "not_found", message: "页面或接口不存在" }));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, error.code === "payload_too_large" ? 413 : 500, errorBody(error));
      else res.end();
    });
  });
  server.requestTimeout = 30_000;

  await monitor.start();
  server.listen(port, host, () => {
    console.log(`[domain-watch] website listening on http://${host}:${port}`);
    console.log(`[domain-watch] data directory: ${dataDir}`);
    console.log(`[domain-watch] Telegram notifications: ${notifier.configured ? "enabled" : "disabled"}`);
    console.log(`[domain-watch] public query: ${publicQuery ? "enabled" : "disabled"}`);
  });

  const shutdown = () => {
    monitor.stop();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(`[domain-watch] website failed to start: ${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
