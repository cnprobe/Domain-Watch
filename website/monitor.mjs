import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, normalizeRefreshInterval } from "./auth.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
// Telegram 限流（429）重试：最多 3 次尝试，退避 1s → 2s，单次等待夹在 0.2–8s。
// 3 次 × 8s 的上限意味着单条通知最多多花 16s，不会把上百个域名的检查拖垮。
const TELEGRAM_MAX_ATTEMPTS = 3;
const TELEGRAM_RETRY_BASE_MS = 1000;
const TELEGRAM_RETRY_MIN_WAIT_MS = 200;
const TELEGRAM_RETRY_MAX_WAIT_MS = 8000;
const DEFAULT_CHECK_TIME = "09:00";
const CHECK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 严格校验 HH:mm：设置面板用它拒绝非法输入，而不是静默回退到 09:00 */
export function isValidCheckTime(value) {
  return CHECK_TIME_PATTERN.test(String(value ?? "").trim());
}

export const REMIND_DAYS_MIN = 0;
export const REMIND_DAYS_MAX = 365;
export const DOMAINS_MAX_LENGTH = 4000;

function parseCheckTime(value) {
  const text = String(value || "").trim() || DEFAULT_CHECK_TIME;
  const match = CHECK_TIME_PATTERN.exec(text);
  return match ? { hour: Number(match[1]), minute: Number(match[2]), text } : { hour: 9, minute: 0, text: DEFAULT_CHECK_TIME };
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 提取 fetch 失败原因：cause 可能是 AggregateError，内层 errors 才带 errno code */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Telegram 限流后该等多久。优先用 Telegram 自己给的值：响应头 Retry-After，
 * 或响应体里的 parameters.retry_after（秒）。都没有就按 1s → 2s 退避。
 * 上下限都夹住，避免 Telegram 报一个很大的 retry_after 把整轮检查拖死。
 */
function retryAfterMs(response, body) {
  const header = Number(response?.headers?.get?.("retry-after"));
  const fromBody = Number(body?.parameters?.retry_after);
  let wait = Number.isFinite(header) && header > 0
    ? header * 1000
    : Number.isFinite(fromBody) && fromBody > 0
      ? fromBody * 1000
      : TELEGRAM_RETRY_BASE_MS;
  return Math.min(Math.max(wait, TELEGRAM_RETRY_MIN_WAIT_MS), TELEGRAM_RETRY_MAX_WAIT_MS);
}

function describeCause(error) {
  const cause = error?.cause;
  if (!cause) return "";
  if (cause.code) return ` (${cause.code})`;
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const codes = [...new Set(cause.errors.map((item) => item?.code).filter(Boolean))];
    if (codes.length > 0) return ` (${codes.join(", ")})`;
  }
  return cause.message ? ` (${cause.message})` : "";
}

/** 取出 API 地址里的主机名，用于报错时提示用户检查设置 */
function hostOf(apiBase) {
  try {
    return new URL(String(apiBase || "")).host || String(apiBase || "");
  } catch {
    return String(apiBase || "");
  }
}

function truncate(value, max = 4000) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export class TelegramNotifier {
  constructor({ token, chatId, apiBase = "https://api.telegram.org", fetchImpl = globalThis.fetch }) {
    this.token = String(token || "").trim();
    this.chatId = String(chatId || "").trim();
    this.apiBase = String(apiBase || "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  update({ token, chatId, apiBase } = {}) {
    if (token !== undefined) this.token = String(token || "").trim();
    if (chatId !== undefined) this.chatId = String(chatId || "").trim();
    if (apiBase !== undefined) this.apiBase = String(apiBase || "https://api.telegram.org").replace(/\/+$/, "");
  }

  get configured() {
    return Boolean(this.token && this.chatId);
  }

  async send(title, message) {
    if (!this.configured) {
      const error = new Error("Telegram 未配置：请设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID");
      error.code = "telegram_not_configured";
      throw error;
    }

    const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(truncate(message))}`;
    const endpoint = `${this.apiBase}/bot${this.token}/sendMessage`;
    const payload = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    // 429 是「现在太快了」，不是「这条消息发不出去」。Telegram 会明确告知该等
    // 多久（响应头 Retry-After，或响应体里的 parameters.retry_after），照它说的
    // 等就能发出去。此前一次 429 就直接判失败，整轮检查的提醒全部静默丢弃。
    for (let attempt = 1; ; attempt++) {
      const result = await this.sendOnce(endpoint, payload);
      if (result.ok) return true;
      if (result.status === 429 && attempt < TELEGRAM_MAX_ATTEMPTS) {
        await sleep(result.waitMs);
        continue;
      }
      const error = new Error(
        result.status === 429
          ? `Telegram 限流，已重试 ${attempt} 次仍未发送：${result.description}`
          : `Telegram API 发送失败 (${result.status}): ${result.description}`,
      );
      error.code = "telegram_error";
      throw error;
    }
  }

  /**
   * 单次发送尝试。
   * 成功返回 { ok: true }；被限流或 API 报错返回 { ok:false, status, description, waitMs }；
   * 网络层失败与超时照旧抛出，由 send() 归类。
   */
  async sendOnce(endpoint, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Keep the HTTP status in the result below.
      }
      if (response.ok && body?.ok) return { ok: true };
      return {
        ok: false,
        status: response.status,
        description: body?.description || raw || response.statusText,
        waitMs: retryAfterMs(response, body),
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Telegram API 请求超时");
        timeout.code = "telegram_timeout";
        throw timeout;
      }
      if (error?.code) throw error;
      // fetch 的网络层失败（DNS/连接/证书）是无 code 的 TypeError，这里补一个可归类的错误码
      const reason = describeCause(error);
      const hint = /ENOTFOUND|EAI_AGAIN/i.test(reason)
        ? `，无法解析主机 ${hostOf(this.apiBase)}，请在设置页面确认 API 地址是否正确`
        : "";
      const failure = new Error(`Telegram API 网络请求失败${reason}${hint}: ${messageOf(error)}`);
      failure.code = "telegram_network_error";
      failure.cause = error;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 到期时间取值：检测到的优先，检测不到才用备注里手填的日期兜底。
 * 手填值只存在 domainMeta 里，检测结果不写回那里，所以它不会被检测覆盖。
 */
function resolveExpiration(detected, note) {
  const raw = detected ? String(detected).trim() : "";
  if (raw) return { expiration: raw, manual: false };
  const manual = String((note && note.expiration) || "").trim();
  return manual ? { expiration: manual, manual: true } : { expiration: "", manual: false };
}

export function createMonitor({ config, domainWatch, notifier, dataDir, settingsStore = null, logger = console }) {
  const statePath = join(dataDir, "reminders.json");

  // 这些值可以在运行时通过 applyConfig() 热更新（设置面板保存后立即生效）
  let checkTime = parseCheckTime(config.checkTime);
  let remindDays = domainWatch.normalizeRemindDays(config.remindDays);
  let domains = domainWatch.parseDomains(config.domains || "");
  let dailyRemind = config.dailyRemind !== false;
  let backorderNotify = config.backorderNotify !== false;
  let runOnStartup = config.runOnStartup === true;
  let refreshInterval = normalizeRefreshInterval(config.refreshInterval);
  let cacheTtl = 10;
  // 缓存时长是模块级状态，必须在 createMonitor 里就推给查询核心，
  // 否则第一次查询会按默认值建缓存，设置面板里的值要等到下次重启才生效。
  applyCacheTtl(config.cacheTtl);
  let configSource = config.source === "panel" ? "panel" : "env";

  let state = null;
  let running = false;
  let timer = null;
  let lastScheduledKey = "";

  /** 把缓存时长推给查询核心；domainWatch 是注入的适配器，可能没有这几个方法 */
  function applyCacheTtl(value) {
    if (typeof domainWatch.setResultCacheTtlMinutes !== "function") {
      cacheTtl = Number(value) > 0 ? Math.floor(Number(value)) : cacheTtl;
      return;
    }
    cacheTtl = domainWatch.setResultCacheTtlMinutes(value);
  }

  /** 缓存现状，供监控页显示「缓存多久 / 何时重新查」 */
  function cacheInfo() {
    if (typeof domainWatch.getResultCacheInfo !== "function") return { cacheTtlMinutes: cacheTtl };
    const info = domainWatch.getResultCacheInfo();
    return { cacheTtlMinutes: info.ttlMinutes, cacheSize: info.size, cacheNextExpiryAt: info.nextExpiryAt };
  }

  async function loadState() {
    if (state) return state;
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn(`[domain-watch] 读取提醒状态失败: ${messageOf(error)}`);
      state = {};
    }
    return state;
  }

  async function saveState() {
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(state || {}, null, 2), "utf8");
      await rename(temporaryPath, statePath);
    } catch (error) {
      logger.error(`[domain-watch] 写入提醒状态失败: ${messageOf(error)}`);
    }
  }

  /**
   * 把一次检查的结论写进日志。之前只在开始时打一行「开始每日检查」，
   * 结束时不留痕，于是「定时跑了吗」「为什么没收到通知」都无法从日志判断。
   */
  function logCheckSummary(source, summary) {
    const parts = [
      `检查 ${summary.checked} 个`,
      `提醒 ${summary.reminded.length} 个`,
      `跳过 ${summary.skipped.length} 个`,
      `失败 ${summary.failed.length} 个`,
    ];
    if (summary.reminded.length > 0) parts.push(`已提醒：${summary.reminded.join("、")}`);
    if (summary.skipped.length > 0) parts.push(`跳过原因：${summary.skipped.join("；")}`);
    if (summary.failed.length > 0) parts.push(`失败原因：${summary.failed.join("；")}`);
    if (summary.reminded.length === 0 && summary.skipped.length > 0) {
      parts.push(`（提醒窗口 ${remindDays} 天内才通知，窗口外的域名不会发消息）`);
    }
    logger.info(`[domain-watch] ${source}完成：${parts.join("，")}`);
  }

  async function check(simulateExpired = false, source = "手动检查") {
    if (running) {
      // busy 让调用方能把「请求被拒绝」与「检查跑完但有域名失败」区分开：
      // 前者是 409，后者是 200 + 逐域名结果，不该混成同一个 5xx
      return { ok: false, busy: true, checked: 0, reminded: [], skipped: [], failed: ["已有检查任务正在运行"] };
    }

    running = true;
    const summary = {
      ok: true,
      checked: domains.length,
      reminded: [],
      skipped: [],
      failed: [],
      failedCodes: [],
    };
    if (simulateExpired) summary.simulated = true;

    try {
      if (domains.length === 0) {
        summary.skipped.push("未配置监控域名");
        return summary;
      }

      const records = await loadState();
      // 手填到期时间也要参与提醒判定，否则列表里显示了倒计时却永远不推送
      const meta = settingsStore ? await settingsStore.getDomainMeta() : {};
      let changed = false;

      for (const domain of domains) {
        try {
          const result = await domainWatch.queryDomain(domain, { fresh: true });
          const { expiration } = resolveExpiration(result.expiration, meta[domain] || {});
          if (!expiration) {
            summary.skipped.push(`${domain}：无到期时间字段`);
            continue;
          }

          const expirationMs = Date.parse(expiration);
          if (Number.isNaN(expirationMs)) {
            summary.skipped.push(`${domain}：到期时间无法解析`);
            continue;
          }

          const daysLeft = simulateExpired ? -1 : Math.ceil((expirationMs - Date.now()) / DAY_MS);
          const record = records[domain];

          if (daysLeft < 0) {
            if (record && record.expiration !== expiration) {
              delete records[domain];
              changed = true;
            }

            const current = records[domain];
            if (current?.backorderAt) {
              summary.skipped.push(`${domain}：已过期，抢注提醒已发过`);
              continue;
            }

            if (backorderNotify) {
              const expiredDays = Math.max(1, Math.abs(daysLeft));
              const message = `域名 ${domain} 已于 ${domainWatch.formatDate(expirationMs)} 到期（已过期 ${expiredDays} 天），已进入删除期，可续费赎回或关注抢注`;
              await notifier.send("🔥 域名抢注提醒", message);
              logger.info(`[domain-watch] 已发送抢注提醒：${domain}（已过期 ${expiredDays} 天）`);
              records[domain] = {
                expiration,
                remindedAt: current?.remindedAt || "",
                backorderAt: new Date().toISOString(),
              };
              changed = true;
              summary.reminded.push(`${domain}（抢注，已过期 ${expiredDays} 天）`);
            } else if (record) {
              delete records[domain];
              changed = true;
              summary.skipped.push(`${domain}：已过期（抢注提醒已关闭）`);
            } else {
              summary.skipped.push(`${domain}：已过期（抢注提醒已关闭）`);
            }
            continue;
          }

          if (daysLeft > remindDays) {
            if (record && record.expiration !== expiration) {
              delete records[domain];
              changed = true;
            }
            summary.skipped.push(`${domain}：剩余 ${daysLeft} 天，未到提醒窗口`);
            continue;
          }

          if (!dailyRemind) {
            summary.skipped.push(`${domain}：剩余 ${daysLeft} 天（每日提醒已关闭）`);
            continue;
          }

          if (record && record.expiration === expiration && domainWatch.isToday(record.remindedAt)) {
            summary.skipped.push(`${domain}：今日已提醒过`);
            continue;
          }

          const message = `域名 ${domain} 将于 ${domainWatch.formatDate(expirationMs)} 到期（剩余 ${daysLeft} 天），请及时续费`;
          await notifier.send("⚠️ 域名到期提醒", message);
          logger.info(`[domain-watch] 已发送到期提醒：${domain}（剩余 ${daysLeft} 天）`);
          records[domain] = { expiration, remindedAt: new Date().toISOString() };
          changed = true;
          summary.reminded.push(`${domain}（剩余 ${daysLeft} 天）`);
        } catch (error) {
          const code = error?.code || "unknown";
          summary.failed.push(`${domain}：${code} ${messageOf(error)}`);
          summary.failedCodes.push(code);
          logger.error(`[domain-watch] 检查 ${domain} 失败: ${code} ${messageOf(error)}`);
        }
      }

      if (changed) await saveState();
      summary.ok = summary.failed.length === 0;
      logCheckSummary(source, summary);
      return summary;
    } finally {
      running = false;
    }
  }

  /** 移除域名时同步清掉它的提醒去重记录，避免重新添加后被误判为"已提醒过" */
  /**
   * 清除提醒记录，让到期提醒和抢注提醒都能再发一次。
   * 同时重置两个标记：remindedAt（今日已提醒）与 backorderAt（已发过抢注提醒）。
   * 记录里的 expiration 会保留，方便对照；不传域名则清全部监控域名。
   */
  async function clearReminderFlags(list) {
    const records = await loadState();
    // 不传列表时清全部：包括已经不在监控列表里的域名。它们若仍带着标记，下次
    // 保存配置时会被 pruneOrphans 跳过（它只清两个标记都空的），残留就永远清不掉
    const targets =
      list === undefined
        ? Object.keys(records)
        : (Array.isArray(list) ? list : [list]).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
    const cleared = [];
    for (const domain of targets) {
      const record = records[domain];
      if (!record || (!record.remindedAt && !record.backorderAt)) continue;
      records[domain] = { ...record, remindedAt: "", backorderAt: "" };
      cleared.push(domain);
    }
    if (cleared.length > 0) {
      await saveState();
      logger.info(`[domain-watch] 已清除提醒记录（含抢注标记）：${cleared.join("、")}`);
    }
    return cleared;
  }

  async function forgetDomains(list) {
    const targets = (Array.isArray(list) ? list : [list]).map((item) => String(item || "").trim()).filter(Boolean);
    if (targets.length === 0) return [];
    const records = await loadState();
    const removed = [];
    for (const domain of targets) {
      if (records[domain]) {
        delete records[domain];
        removed.push(domain);
      }
    }
    if (removed.length > 0) await saveState();
    // 域名移出监控后，价格/商家这些备注也一并清掉，避免残留
    if (settingsStore) {
      try {
        await settingsStore.setDomainMeta({ remove: targets });
      } catch (error) {
        logger.warn(`[domain-watch] 清理域名备注失败: ${messageOf(error)}`);
      }
    }
    return removed;
  }

  /**
   * 域名列表被整体改写（设置页文本框 / 恢复为 .env）后，清理已不在列表里的残留。
   *
   * 监控页的「移除」按钮走 forgetDomains，那条路径一直是干净的；这里补上另一条。
   * 之前从设置页删掉的域名，其提醒记录会永远留在 reminders.json 里（无界增长），
   * 价格/商家备注也会留在 settings.json 里——将来重新加回这个域名，界面会带出
   * 早已过期的旧价格和旧商家。
   *
   * keep 必须取**新**列表。旧列表在 .env 兜底场景下与生效值并不相同：站点启动时
   * 若设置面板为空，域名来自 .env，此时把旧面板列表传进来会把仍在监控的域名
   * 误判成残留。
   *
   * 只清理「两个标记都为空」的记录：有未发出去的提醒时保留，避免用户刚被提醒过
   * 就把域名删掉、再加回来时丢掉提醒状态。
   */
  async function pruneOrphans(nextDomains) {
    if (!settingsStore) return [];
    const keep = new Set(domainWatch.parseDomains(String(nextDomains || "")));
    const records = await loadState();
    const meta = await settingsStore.getDomainMeta();
    // 候选来自两个地方：reminders.json 的记录与 settings.json 的备注。只看前者会漏掉
    // 「加过域名、写了备注、但从没触发过提醒」的情况——那种域名在 reminders.json 里
    // 根本没有条目，备注就会一直留着，重新加回时带出旧价格。
    const candidates = new Set([...Object.keys(records), ...Object.keys(meta)]);
    const orphans = [...candidates].filter((domain) => {
      if (keep.has(domain)) return false;
      const record = records[domain];
      return !record?.remindedAt && !record?.backorderAt;
    });
    if (orphans.length === 0) return [];
    for (const domain of orphans) delete records[domain];
    await saveState();
    try {
      await settingsStore.setDomainMeta({ remove: orphans });
    } catch (error) {
      logger.warn(`[domain-watch] 清理已移除域名的备注失败: ${messageOf(error)}`);
    }
    logger.info(`[domain-watch] 已清理 ${orphans.length} 个不在监控列表中的域名残留：${orphans.join("、")}`);
    return orphans;
  }

  function isDue(now) {
    return now.getHours() === checkTime.hour && now.getMinutes() === checkTime.minute;
  }

  /**
   * 热更新监控配置：设置面板保存后调用，无需重启容器。
   * 未传入的字段保持原值；检查时间变化时重置当日去重键，
   * 这样把时间改成当前分钟就能在下一次轮询立刻跑一次检查。
   */
  function applyConfig(next = {}) {
    const previous = currentConfig();

    if (next.domains !== undefined) domains = domainWatch.parseDomains(String(next.domains || ""));
    if (next.remindDays !== undefined) remindDays = domainWatch.normalizeRemindDays(next.remindDays);
    if (next.dailyRemind !== undefined) dailyRemind = next.dailyRemind !== false;
    if (next.backorderNotify !== undefined) backorderNotify = next.backorderNotify !== false;
    if (next.runOnStartup !== undefined) runOnStartup = next.runOnStartup === true;
    if (next.refreshInterval !== undefined) refreshInterval = normalizeRefreshInterval(next.refreshInterval);
    if (next.cacheTtl !== undefined) applyCacheTtl(next.cacheTtl);
    if (next.checkTime !== undefined) {
      checkTime = parseCheckTime(next.checkTime);
      if (checkTime.text !== previous.checkTime) lastScheduledKey = "";
    }
    if (next.source !== undefined) configSource = next.source === "panel" ? "panel" : "env";

    return { previous, current: currentConfig() };
  }

  /** 当前生效的配置（可直接回显到设置面板） */
  function currentConfig() {
    return {
      domains: domains.join(","),
      remindDays,
      checkTime: checkTime.text,
      dailyRemind,
      backorderNotify,
      runOnStartup,
      refreshInterval,
      cacheTtl,
      source: configSource,
    };
  }

  async function runScheduledCheck() {
    const now = new Date();
    const key = localDayKey(now);
    if (!isDue(now) || lastScheduledKey === key) return;
    lastScheduledKey = key;
    logger.info(`[domain-watch] 开始每日检查（${checkTime.text}）`);
    await check(false, "每日定时检查");
  }

  async function start() {
    await mkdir(dataDir, { recursive: true });
    if (runOnStartup) await check(false, "启动时检查");
    await runScheduledCheck();
    timer = setInterval(() => {
      runScheduledCheck().catch((error) => logger.error(`[domain-watch] 定时检查失败: ${messageOf(error)}`));
    }, 30_000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * 查一个域名并组装成监控列表里的一行。抽出来是为了让 snapshot() 和单行刷新
   * 共用同一套逻辑——两边的到期时间兜底、备注回填必须一致，否则单行刷新会
   * 显示出和整表不同的结果。
   */
  async function buildItem(domain, records, meta, fresh = false) {
    const note = meta[domain] || {};
    try {
      const result = await domainWatch.queryDomain(domain, { fresh });
      const { expiration, manual: expirationManual } = resolveExpiration(result.expiration, note);
      const expirationMs = expiration ? Date.parse(expiration) : NaN;
      const daysLeft = Number.isNaN(expirationMs) ? null : Math.ceil((expirationMs - Date.now()) / DAY_MS);
      let state = "unknown";
      if (daysLeft !== null) {
        if (daysLeft < 0) state = "expired";
        else if (daysLeft <= remindDays) state = "expiring";
        else state = "ok";
      }
      const record = records[domain] || null;
      return {
        state,
        item: {
          ok: true,
          domain,
          state,
          expiration: expiration || null,
          expirationDate: Number.isNaN(expirationMs) ? null : domainWatch.formatDate(expirationMs),
          // 检测不到到期时间、正好吃的是手填值
          expirationManual,
          metaExpiration: note.expiration || "",
          daysLeft,
          source: result.source || null,
          registrar: result.registrar || null,
          lastChanged: result.lastChanged || null,
          remindedAt: record?.remindedAt || null,
          backorderAt: record?.backorderAt || null,
          // 续费价格 / 商家 / 商家网站：RDAP 与 WHOIS 都不提供，需自行填写
          price: note.price || "",
          vendor: note.vendor || "",
          vendorUrl: note.vendorUrl || "",
          registrarName: (result.registrar && result.registrar.name) || "",
        },
      };
    } catch (error) {
      return {
        state: "failed",
        item: {
          ok: false,
          domain,
          state: "failed",
          error: { code: error?.code || "unknown", message: error instanceof Error ? error.message : String(error) },
          expirationManual: false,
          metaExpiration: note.expiration || "",
          price: note.price || "",
          vendor: note.vendor || "",
          vendorUrl: note.vendorUrl || "",
          registrarName: "",
        },
      };
    }
  }

  async function snapshot() {
    const records = await loadState();
    const meta = settingsStore ? await settingsStore.getDomainMeta() : {};
    const items = [];
    const summary = { total: domains.length, ok: 0, expiring: 0, expired: 0, unknown: 0, failed: 0 };

    for (const domain of domains) {
      const { state, item } = await buildItem(domain, records, meta, false);
      if (state === "ok") summary.ok++;
      else if (state === "expiring") summary.expiring++;
      else if (state === "expired") summary.expired++;
      else if (state === "failed") summary.failed++;
      else summary.unknown++;
      items.push(item);
    }

    return {
      ok: summary.failed === 0,
      checkedAt: new Date().toISOString(),
      checkTime: checkTime.text,
      remindDays,
      // 前端据此决定多久自动刷新一次
      refreshInterval,
      ...cacheInfo(),
      configSource,
      telegramConfigured: notifier.configured,
      summary,
      items,
    };
  }

  /**
   * 逐个域名产出结果，供 SSE 端点边查边推——前端因此能在第一个域名返回时就
   * 显示第一行，而不是干等整表（8 个域名串行约 5 秒）。
   * 刻意保持串行（和 snapshot() 一致）：并发打 RDAP/WHOIS 容易触发限流，
   * 而且串行让到达顺序确定，前端才能按到达顺序逐行淡入。
   * 每次 yield 都带上累计 summary，前端可以边收边更新统计数字。
   */
  async function* streamSnapshot() {
    const records = await loadState();
    const meta = settingsStore ? await settingsStore.getDomainMeta() : {};
    const summary = { total: domains.length, ok: 0, expiring: 0, expired: 0, unknown: 0, failed: 0 };
    for (const domain of domains) {
      const { state, item } = await buildItem(domain, records, meta, false);
      if (state === "ok") summary.ok++;
      else if (state === "expiring") summary.expiring++;
      else if (state === "expired") summary.expired++;
      else if (state === "failed") summary.failed++;
      else summary.unknown++;
      yield { type: "item", item, summary: { ...summary } };
    }
    yield {
      type: "done",
      checkedAt: new Date().toISOString(),
      checkTime: checkTime.text,
      remindDays,
      refreshInterval,
      ...cacheInfo(),
      configSource,
      telegramConfigured: notifier.configured,
      summary,
    };
  }

  /**
   * 只重查一个域名，给列表里的「刷新」用。比整表刷新快得多（RDAP 查询按秒计），
   * 而且刻意不重算 summary、不发通知——它只是把这一行的数据换成最新的。
   */
  async function refreshDomain(domain) {
    const key = String(domain || "").trim().toLowerCase();
    if (!domains.includes(key)) {
      throw fail("unknown_domain", `${key || domain} 不在监控列表中`);
    }
    const records = await loadState();
    const meta = settingsStore ? await settingsStore.getDomainMeta() : {};
    const { item } = await buildItem(key, records, meta, true);
    return item;
  }

  function status() {
    return {
      domains,
      remindDays,
      checkTime: checkTime.text,
      dailyRemind,
      backorderNotify,
      runOnStartup,
      configSource,
      telegramConfigured: notifier.configured,
      running: Boolean(timer),
      checking: running,
    };
  }

  return { check, snapshot, streamSnapshot, refreshDomain, start, stop, status, applyConfig, currentConfig, forgetDomains, clearReminderFlags, pruneOrphans };
}
