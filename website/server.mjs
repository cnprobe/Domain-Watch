import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createDomainWatch } from "./domain-watch.mjs";
import { createMonitor, isValidCheckTime, REMIND_DAYS_MAX, REMIND_DAYS_MIN, DOMAINS_MAX_LENGTH, TelegramNotifier } from "./monitor.mjs";
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

/** 统一「错误码 → HTTP 状态码」，避免同一错误在不同路由返回不同状态 */
function statusForError(error, fallback = 400) {
  const code = typeof error === "string" ? error : error?.code;
  if (code === "payload_too_large") return 413;
  if (code === "too_many_attempts") return 429;
  if (code === "csrf_rejected") return 403;
  if (code === "not_found") return 404;
  return fallback;
}
function sendError(res, error, fallback = 400) {
  sendJson(res, statusForError(error, fallback), errorBody(error));
}

function sendJson(res, statusCode, value) {
  res.statusCode = statusCode;  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

function statusForLookupError(code) {
  if (code === "not_found") return 404;
  if (code === "invalid_domain" || code === "invalid_argument") return 400;
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

/** 校验并规范化 Telegram Bot API 地址，避免粘贴错误变成难懂的 ENOTFOUND */
function normalizeTelegramApiBase(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/\s/.test(text)) {
    throw fail("invalid_telegram_api_base", "API 地址不能包含空格，请检查是否粘贴完整");
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail("invalid_telegram_api_base", "API 地址格式不正确，应形如 https://api.telegram.org");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw fail("invalid_telegram_api_base", "API 地址必须以 http:// 或 https:// 开头");
  }
  if (url.username || url.password) {
    throw fail("invalid_telegram_api_base", "API 地址不能包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw fail("invalid_telegram_api_base", "API 地址不能包含查询参数或 # 片段");
  }
  // 粘贴错位会留下第二段协议，例如 "https://api.telegrhttps://api.telegram.org/bot..."
  if (text.slice(text.indexOf("://") + 3).includes("://")) {
    throw fail("invalid_telegram_api_base", "API 地址中出现了两段协议，请检查是否粘贴错位（官方地址：https://api.telegram.org）");
  }
  // 主机名必须是完整域名或 localhost
  if (!url.hostname.includes(".") && url.hostname !== "localhost") {
    throw fail("invalid_telegram_api_base", `API 地址的主机名 "${url.hostname}" 不完整（官方地址：https://api.telegram.org）`);
  }
  if (/\.\./.test(url.hostname) || url.hostname.startsWith(".") || url.hostname.endsWith(".")) {
    throw fail("invalid_telegram_api_base", `API 地址的主机名 "${url.hostname}" 格式不正确，请检查是否粘贴错位`);
  }
  return url.toString().replace(/\/+$/, "");
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

  const domainWatch = createDomainWatch({ dataDir });
  // 可选：挂载外部 JSON 覆盖「后缀 → RDAP 地址」映射（只读，按 mtime 自动重载）
  domainWatch.setOverridesFile(process.env.RDAP_OVERRIDES_FILE || "");
  await domainWatch.loadOverridesFile(true);
  const telegramConfig = await settingsStore.getTelegramConfig();
  const notifier = new TelegramNotifier(telegramConfig);
  const savedRdap = await settingsStore.getRdapSettings();
  if (Object.keys(savedRdap.tlds).length > 0) domainWatch.setRdapOverrides(savedRdap.tlds);
  // 监控参数优先使用设置面板保存的值，没有保存过才用 .env
  const monitorConfig = await settingsStore.getMonitorSettings();
  const monitor = createMonitor({ config: monitorConfig, domainWatch, notifier, dataDir });
  const legacyAdminToken = String(process.env.ADMIN_TOKEN || "").trim();
  const loginAttempts = new Map();
  let publicHtml = { value: null };
  let monitorHtml = { value: null };
  let loginHtml = { value: null };
  let settingsHtml = { value: null };

  if (legacyAdminToken) {
    console.warn("[domain-watch] ADMIN_TOKEN is deprecated; use the single-user login session instead");
  }

  /** RDAP 映射接口的统一返回结构：面板层 + 文件层 + 合并结果 */
  function rdapPayload() {
    const current = domainWatch.getRdapOverrides();
    const fileCount = Object.keys(current.file).length;
    return {
      rdap: {
        panel: current.panel,
        file: current.file,
        effective: current.effective,
        filePath: current.filePath,
        fileError: current.fileError,
        counts: {
          panel: Object.keys(current.panel).length,
          file: fileCount,
          effective: Object.keys(current.effective).length,
        },
        precedence: "同名后缀以文件层优先",
      },
    };
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
        sendError(res, error);
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
        sendError(res, error);
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
      sendJson(res, 200, {
        ok: true,
        settings: await settingsStore.publicSettings(),
        monitor: monitor.status(),
        monitorConfig: await settingsStore.getMonitorSettings(),
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/monitor") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);

        if (body.reset === true) {
          const restored = await settingsStore.resetMonitorSettings();
          const { previous, current } = monitor.applyConfig({ ...restored, source: "env" });
          console.log(`[domain-watch] 监控配置已恢复为 .env：${previous.domains || "未配置"} -> ${current.domains || "未配置"}`);
          sendJson(res, 200, { ok: true, monitorConfig: restored, monitor: monitor.status(), message: "已恢复为 .env 中的配置" });
          return;
        }

        // 未提供的字段沿用当前生效值，避免部分更新时报出与本次修改无关的错误
        const previousPanel = await settingsStore.getMonitorSettings();
        const domains = body.domains === undefined ? String(previousPanel.domains ?? "") : String(body.domains);
        if (domains.length > DOMAINS_MAX_LENGTH) {
          throw fail("invalid_domains", `监控域名内容过长（最多 ${DOMAINS_MAX_LENGTH} 字符）`);
        }
        const validDomains = domainWatch.parseDomains(domains);
        if (domains.trim() && validDomains.length === 0) {
          throw fail("invalid_domains", "没有解析到有效域名，请用逗号或换行分隔，例如 example.com");
        }

        const remindDays = Number(body.remindDays === undefined ? previousPanel.remindDays : body.remindDays);
        if (!Number.isFinite(remindDays) || remindDays < REMIND_DAYS_MIN || remindDays > REMIND_DAYS_MAX) {
          throw fail("invalid_remind_days", `提前提醒天数必须是 ${REMIND_DAYS_MIN}-${REMIND_DAYS_MAX} 之间的数字`);
        }

        const checkTime = body.checkTime === undefined ? String(previousPanel.checkTime ?? "") : String(body.checkTime).trim();
        if (!isValidCheckTime(checkTime)) {
          throw fail("invalid_check_time", "每日检查时间格式必须是 HH:mm（24 小时制），例如 09:00");
        }

        const saved = await settingsStore.setMonitorSettings({
          domains,
          remindDays: Math.floor(remindDays),
          dailyRemind: (body.dailyRemind === undefined ? previousPanel.dailyRemind : body.dailyRemind) !== false,
          backorderNotify: (body.backorderNotify === undefined ? previousPanel.backorderNotify : body.backorderNotify) !== false,
          checkTime,
          runOnStartup: (body.runOnStartup === undefined ? previousPanel.runOnStartup : body.runOnStartup) === true,
        });
        const { current } = monitor.applyConfig({ ...saved, source: "panel" });
        console.log(
          `[domain-watch] 监控配置已更新（设置面板）: 域名 ${saved.domains || "未配置"}，` +
            `检查时间 ${current.checkTime}，提醒天数 ${current.remindDays}`
        );
        sendJson(res, 200, { ok: true, monitorConfig: saved, monitor: monitor.status(), message: "监控配置已保存并立即生效" });
      } catch (error) {
        sendError(res, error);
      }
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/monitor/domains") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);
        const current = await settingsStore.getMonitorSettings();
        const list = domainWatch.parseDomains(current.domains || "");

        const added = [];
        if (body.add !== undefined && String(body.add).trim() !== "") {
          const raw = String(body.add);
          if (raw.length > DOMAINS_MAX_LENGTH) {
            throw fail("invalid_domains", `域名内容过长（最多 ${DOMAINS_MAX_LENGTH} 字符）`);
          }
          const parsed = domainWatch.parseDomains(raw);
          if (parsed.length === 0) {
            throw fail("invalid_domains", `无法识别为域名：${raw.trim().slice(0, 60)}`);
          }
          for (const domain of parsed) {
            if (!list.includes(domain)) {
              list.push(domain);
              added.push(domain);
            }
          }
        }

        const removed = [];
        if (body.remove !== undefined && String(body.remove).trim() !== "") {
          const targets = domainWatch.parseDomains(String(body.remove));
          if (targets.length === 0) {
            throw fail("invalid_domains", `无法识别为域名：${String(body.remove).trim().slice(0, 60)}`);
          }
          for (const target of targets) {
            const index = list.indexOf(target);
            if (index >= 0) {
              list.splice(index, 1);
              removed.push(target);
            }
          }
        }

        if (added.length === 0 && removed.length === 0) {
          sendJson(res, 400, errorBody({
            code: "no_domain_change",
            message: body.add !== undefined && !added.length
              ? "要添加的域名已在监控列表中"
              : "要移除的域名不在监控列表中",
          }));
          return;
        }

        const saved = await settingsStore.setMonitorSettings({ ...current, domains: list.join(",") });
        monitor.applyConfig({ ...saved, source: "panel" });
        if (removed.length > 0) await monitor.forgetDomains(removed);

        const parts = [];
        if (added.length > 0) parts.push(`已添加 ${added.join("、")}`);
        if (removed.length > 0) parts.push(`已移除 ${removed.join("、")}`);
        console.log(`[domain-watch] 监控域名变更（设置面板）: ${parts.join("；")}`);
        sendJson(res, 200, {
          ok: true,
          monitorConfig: saved,
          monitor: monitor.status(),
          added,
          removed,
          message: `${parts.join("，")}，当前共 ${list.length} 个域名`,
        });
      } catch (error) {
        sendError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/rdap") {
      const auth = requireApiAuth(req, res);
      if (!auth) return;
      sendJson(res, 200, { ok: true, ...rdapPayload() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/rdap/tlds") {
      const auth = requireApiAuth(req, res);
      if (!auth) return;
      try {
        const tlds = await domainWatch.getTldList();
        sendJson(res, 200, { ok: true, count: tlds.length, tlds });
      } catch (error) {
        sendJson(res, 502, errorBody(error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/rdap") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      await domainWatch.loadOverridesFile(true);
      const current = domainWatch.getRdapOverrides();
      if (!current.filePath) {
        sendJson(res, 400, errorBody({ code: "rdap_file_not_configured", message: "未配置 RDAP_OVERRIDES_FILE，没有可载入的外部文件" }));
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...rdapPayload(),
        message: `已从文件重新载入，共 ${Object.keys(current.file).length} 个后缀`,
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/rdap") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);

        if (body.reset === true) {
          await settingsStore.resetRdapSettings();
          domainWatch.clearRdapOverrides();
          console.log("[domain-watch] 已清空设置面板中的 RDAP 映射（文件层不受影响）");
          sendJson(res, 200, { ok: true, ...rdapPayload(), message: "已清空设置面板中的 RDAP 映射" });
          return;
        }

        const result = domainWatch.normalizeOverrideMap(body.tlds);
        if (result.errors.length > 0) {
          throw fail("invalid_rdap_overrides", result.errors.join("；"));
        }
        await settingsStore.setRdapSettings(result.tlds);
        domainWatch.setRdapOverrides(result.tlds);
        sendJson(res, 200, { ok: true, ...rdapPayload(), message: `RDAP 映射已保存并立即生效，共 ${Object.keys(result.tlds).length} 个后缀` });
      } catch (error) {
        sendError(res, error);
      }
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/telegram") {
      const auth = requireApiAuth(req, res);
      if (!auth || !requireSameOriginForSession(req, res, auth)) return;
      try {
        const body = await readJsonBody(req);
        const next = await settingsStore.setTelegram({ ...body, apiBase: normalizeTelegramApiBase(body.apiBase) });
        notifier.update(next);
        sendJson(res, 200, { ok: true, settings: await settingsStore.publicSettings() });
      } catch (error) {
        sendError(res, error);
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
        sendJson(res, statusForLookupError(error?.code), errorBody(error));
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
      if (!res.headersSent) sendError(res, error, 500);
      else res.end();
    });
  });
  server.requestTimeout = 30_000;

  await monitor.start();
  server.listen(port, host, () => {
    console.log(`[domain-watch] website listening on http://${host}:${port}`);
    console.log(`[domain-watch] data directory: ${dataDir}`);
    console.log(`[domain-watch] Telegram notifications: ${notifier.configured ? `enabled (${notifier.apiBase})` : "disabled"}`);
    console.log(`[domain-watch] public query: ${publicQuery ? "enabled" : "disabled"}`);
    const applied = monitor.currentConfig();
    console.log(`[domain-watch] 监控配置来源: ${applied.source === "panel" ? "设置面板" : ".env"}（可在设置页面修改并立即生效）`);
    console.log(`[domain-watch] 监控域名: ${applied.domains || "未配置"}，检查时间 ${applied.checkTime}，提醒天数 ${applied.remindDays}`);
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
