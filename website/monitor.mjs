import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(truncate(message))}`;
    const endpoint = `${this.apiBase}/bot${this.token}/sendMessage`;

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Keep the HTTP status in the error below.
      }

      if (!response.ok || !body?.ok) {
        const description = body?.description || raw || response.statusText;
        const error = new Error(`Telegram API 发送失败 (${response.status}): ${description}`);
        error.code = "telegram_error";
        throw error;
      }
      return true;
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

export function createMonitor({ config, domainWatch, notifier, dataDir, settingsStore = null, logger = console }) {
  const statePath = join(dataDir, "reminders.json");

  // 这些值可以在运行时通过 applyConfig() 热更新（设置面板保存后立即生效）
  let checkTime = parseCheckTime(config.checkTime);
  let remindDays = domainWatch.normalizeRemindDays(config.remindDays);
  let domains = domainWatch.parseDomains(config.domains || "");
  let dailyRemind = config.dailyRemind !== false;
  let backorderNotify = config.backorderNotify !== false;
  let runOnStartup = config.runOnStartup === true;
  let configSource = config.source === "panel" ? "panel" : "env";

  let state = null;
  let running = false;
  let timer = null;
  let lastScheduledKey = "";

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
      return { ok: false, checked: 0, reminded: [], skipped: [], failed: ["已有检查任务正在运行"] };
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
      let changed = false;

      for (const domain of domains) {
        try {
          const result = await domainWatch.queryDomain(domain);
          const expiration = result.expiration ? String(result.expiration) : "";
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
    const targets =
      list === undefined
        ? domains.slice()
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

  async function snapshot() {
    const records = await loadState();
    const meta = settingsStore ? await settingsStore.getDomainMeta() : {};
    const items = [];
    const summary = { total: domains.length, ok: 0, expiring: 0, expired: 0, unknown: 0, failed: 0 };

    for (const domain of domains) {
      try {
        const result = await domainWatch.queryDomain(domain);
        const expiration = result.expiration ? String(result.expiration) : "";
        const expirationMs = expiration ? Date.parse(expiration) : NaN;
        const daysLeft = Number.isNaN(expirationMs) ? null : Math.ceil((expirationMs - Date.now()) / DAY_MS);
        let state = "unknown";
        if (daysLeft !== null) {
          if (daysLeft < 0) state = "expired";
          else if (daysLeft <= remindDays) state = "expiring";
          else state = "ok";
        }
        const record = records[domain] || null;
        if (state === "ok") summary.ok++;
        else if (state === "expiring") summary.expiring++;
        else if (state === "expired") summary.expired++;
        else summary.unknown++;
        const note = meta[domain] || {};
        items.push({
          ok: true,
          domain,
          state,
          expiration: expiration || null,
          expirationDate: Number.isNaN(expirationMs) ? null : domainWatch.formatDate(expirationMs),
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
        });
      } catch (error) {
        summary.failed++;
        const note = meta[domain] || {};
        items.push({
          ok: false,
          domain,
          state: "failed",
          error: { code: error?.code || "unknown", message: error instanceof Error ? error.message : String(error) },
          price: note.price || "",
          vendor: note.vendor || "",
          vendorUrl: note.vendorUrl || "",
          registrarName: "",
        });
      }
    }

    return {
      ok: summary.failed === 0,
      checkedAt: new Date().toISOString(),
      checkTime: checkTime.text,
      remindDays,
      configSource,
      telegramConfigured: notifier.configured,
      summary,
      items,
    };
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

  return { check, snapshot, start, stop, status, applyConfig, currentConfig, forgetDomains, clearReminderFlags };
}
