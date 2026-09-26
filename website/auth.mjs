import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const SETTINGS_FILE = "settings.json";
const KEY_FILE = "config.key";
const VERSION = 1;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

function randomPassword() {
  return randomBytes(18).toString("base64url");
}

/** 构造带 code 属性的 Error，错误码与 src/domain-core.ts 使用同一套 snake_case 约定 */
export function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function validateUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw fail("invalid_username", "用户名只能包含字母、数字、点、下划线和短横线，长度 1-64");
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw fail("invalid_password", `密码长度必须为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 个字符`);
  }
  return password;
}

function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function passwordMatches(password, record) {
  if (!record?.salt || !record?.hash) return false;
  try {
    const actual = Buffer.from(passwordHash(password, record.salt).hash, "hex");
    const expected = Buffer.from(record.hash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function encryptValue(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return ["v1", encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join(".");
}

function decryptValue(value, key) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw fail("settings_corrupted", "encrypted settings format is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, decode(parts[1]));
  decipher.setAuthTag(decode(parts[2]));
  return Buffer.concat([decipher.update(decode(parts[3])), decipher.final()]).toString("utf8");
}

function maskChatId(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateFile(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function envFlag(value) {
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

/** 与 server.mjs 的 envBoolean 语义一致：未设置时返回 fallback */
function envBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return envFlag(value);
}

export class SettingsStore {
  constructor({ dataDir, env = process.env, logger = console }) {
    if (!dataDir) throw fail("invalid_data_dir", "dataDir is required");
    this.dataDir = dataDir;
    this.env = env;
    this.logger = logger;
    this.settingsFile = join(dataDir, SETTINGS_FILE);
    this.keyFile = join(dataDir, KEY_FILE);
    this.key = null;
    this.data = null;
    this.initialCredentials = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.key = await this.loadKey();
    this.data = await this.loadSettings();
    let changed = false;

    if (!this.data.auth) {
      const username = validateUsername(this.env.ADMIN_USERNAME || "admin");
      const password = randomPassword();
      this.data.auth = {
        username,
        password: passwordHash(password),
        sessionSecret: encode(randomBytes(32)),
        createdAt: new Date().toISOString(),
      };
      this.initialCredentials = { username, password, reason: "created" };
      changed = true;
    } else if (envFlag(this.env.RESET_ADMIN_PASSWORD)) {
      const password = randomPassword();
      this.data.auth.password = passwordHash(password);
      this.data.auth.sessionSecret = encode(randomBytes(32));
      this.data.auth.resetAt = new Date().toISOString();
      this.initialCredentials = { username: this.data.auth.username, password, reason: "reset" };
      changed = true;
    }

    if (!this.data.telegram) {
      const envTelegram = this.readTelegramFromEnv();
      if (envTelegram.token && envTelegram.chatId) {
        this.data.telegram = this.encodeTelegram(envTelegram);
        changed = true;
      }
    }

    if (changed || !(await fileExists(this.settingsFile))) await this.save();
    return { initialCredentials: this.initialCredentials };
  }

  async loadKey() {
    if (this.env.CONFIG_ENCRYPTION_KEY) {
      return createHash("sha256").update(this.env.CONFIG_ENCRYPTION_KEY).digest();
    }
    try {
      const raw = await readFile(this.keyFile, "utf8");
      const key = Buffer.from(raw.trim(), "base64url");
      if (key.length !== 32) throw fail("invalid_config_key", "config.key must contain 32 bytes");
      return key;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (await fileExists(this.settingsFile)) {
        throw fail("invalid_config_key", "config.key is missing; cannot decrypt existing Telegram settings");
      }
      const key = randomBytes(32);
      await writePrivateFile(this.keyFile, encode(key));
      return key;
    }
  }

  async loadSettings() {
    try {
      const raw = await readFile(this.settingsFile, "utf8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") throw fail("settings_corrupted", "settings file is invalid");
      data.version = data.version || VERSION;
      return data;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: VERSION };
      if (error?.code) throw error;
      if (error instanceof SyntaxError) throw fail("settings_corrupted", `settings.json 不是有效 JSON: ${error.message}`, error);
      throw fail("settings_unreadable", `cannot read settings.json: ${error.message}`, error);
    }
  }

  async save() {
    await writePrivateFile(this.settingsFile, JSON.stringify(this.data, null, 2));
  }

  readTelegramFromEnv() {
    return {
      token: String(this.env.TELEGRAM_BOT_TOKEN || "").trim(),
      chatId: String(this.env.TELEGRAM_CHAT_ID || "").trim(),
      apiBase: String(this.env.TELEGRAM_API_BASE || "https://api.telegram.org").trim(),
    };
  }

  /** .env 中的监控参数，作为首次启动的默认值 */
  readMonitorFromEnv() {
    const remindDays = Number(this.env.REMIND_DAYS);
    return {
      domains: String(this.env.DOMAINS || ""),
      remindDays: Number.isFinite(remindDays) ? remindDays : 30,
      dailyRemind: envBoolean(this.env.DAILY_REMIND, true),
      backorderNotify: envBoolean(this.env.BACKORDER_NOTIFY, true),
      checkTime: String(this.env.CHECK_TIME || "09:00").trim(),
      runOnStartup: envBoolean(this.env.RUN_ON_STARTUP, false),
    };
  }

  /** 生效的监控配置：面板保存过就用面板的，否则用 .env */
  async getMonitorSettings() {
    const stored = this.data.monitor;
    if (!stored) return { ...this.readMonitorFromEnv(), source: "env" };
    return {
      domains: String(stored.domains ?? ""),
      remindDays: Number(stored.remindDays ?? 30),
      dailyRemind: stored.dailyRemind !== false,
      backorderNotify: stored.backorderNotify !== false,
      checkTime: String(stored.checkTime ?? "09:00"),
      runOnStartup: stored.runOnStartup === true,
      source: "panel",
      updatedAt: stored.updatedAt || null,
    };
  }

  /** 设置面板保存的 RDAP 映射（外部文件层由 domain-core 负责） */
  async getRdapSettings() {
    const stored = this.data.rdap;
    if (!stored) return { tlds: {}, updatedAt: null };
    return { tlds: stored.tlds && typeof stored.tlds === "object" ? stored.tlds : {}, updatedAt: stored.updatedAt || null };
  }

  async setRdapSettings(tlds) {
    this.data.rdap = { tlds, updatedAt: new Date().toISOString() };
    await this.save();
    return this.getRdapSettings();
  }

  async resetRdapSettings() {
    delete this.data.rdap;
    await this.save();
    return this.getRdapSettings();
  }

  async setMonitorSettings(next) {
    const remindDays = Number(next.remindDays ?? 30);
    this.data.monitor = {
      domains: String(next.domains ?? ""),
      remindDays: Number.isFinite(remindDays) ? Math.max(0, Math.min(365, Math.floor(remindDays))) : 30,
      dailyRemind: next.dailyRemind !== false,
      backorderNotify: next.backorderNotify !== false,
      checkTime: String(next.checkTime ?? "09:00"),
      runOnStartup: next.runOnStartup === true,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
    return this.getMonitorSettings();
  }

  /** 丢弃面板配置，回到 .env 中的值 */
  async resetMonitorSettings() {
    delete this.data.monitor;
    await this.save();
    return this.getMonitorSettings();
  }

  encodeTelegram({ token, chatId, apiBase, enabled = true }) {
    return {
      enabled: enabled !== false,
      token: enabled !== false && token ? encryptValue(token, this.key) : null,
      chatId: enabled !== false && chatId ? encryptValue(chatId, this.key) : null,
      apiBase: apiBase ? encryptValue(apiBase, this.key) : null,
      updatedAt: new Date().toISOString(),
    };
  }

  async getTelegramConfig() {
    const stored = this.data.telegram;
    if (!stored || stored.enabled === false) {
      return { token: "", chatId: "", apiBase: "https://api.telegram.org" };
    }
    try {
      return {
        token: stored.token ? decryptValue(stored.token, this.key) : "",
        chatId: stored.chatId ? decryptValue(stored.chatId, this.key) : "",
        apiBase: stored.apiBase ? decryptValue(stored.apiBase, this.key) : "https://api.telegram.org",
      };
    } catch (error) {
      throw fail("telegram_decrypt_failed", `cannot decrypt Telegram settings: ${error.message}`, error);
    }
  }

  async setTelegram({ token, chatId, apiBase, enabled = true }) {
    const current = await this.getTelegramConfig();
    if (enabled === false) {
      this.data.telegram = this.encodeTelegram({ enabled: false, apiBase: apiBase || current.apiBase });
    } else {
      const nextToken = String(token || current.token || "").trim();
      const nextChatId = String(chatId || current.chatId || "").trim();
      if (!nextToken || !nextChatId) throw fail("invalid_telegram_settings", "Telegram Token 和 Chat ID 不能为空");
      this.data.telegram = this.encodeTelegram({
        token: nextToken,
        chatId: nextChatId,
        apiBase: String(apiBase || current.apiBase || "https://api.telegram.org").trim(),
      });
    }
    await this.save();
    return this.getTelegramConfig();
  }

  get username() {
    return this.data.auth.username;
  }

  get createdAt() {
    return this.data.auth.createdAt;
  }

  get sessionTtlDays() {
    const value = Number(this.env.SESSION_TTL_DAYS || 7);
    return Number.isFinite(value) ? Math.max(1, Math.min(30, Math.floor(value))) : 7;
  }

  async authenticate(username, password) {
    const auth = this.data.auth;
    return String(username || "") === auth.username && passwordMatches(String(password || ""), auth.password);
  }

  async changeCredentials({ currentPassword, username, newPassword }) {
    if (!(await this.authenticate(this.data.auth.username, currentPassword))) {
      throw fail("invalid_credentials", "当前密码不正确");
    }
    // 省略的字段保持原值，只有真正修改登录凭据时才需要当前密码
    const wantsUsername = username !== undefined && String(username).trim() !== "";
    const wantsPassword = newPassword !== undefined && String(newPassword) !== "";
    if (!wantsUsername && !wantsPassword) {
      throw fail("invalid_argument", "请提供新的用户名或新密码");
    }
    const nextUsername = wantsUsername ? validateUsername(username) : this.data.auth.username;
    const nextPassword = wantsPassword ? validatePassword(newPassword) : null;
    this.data.auth.username = nextUsername;
    if (nextPassword !== null) this.data.auth.password = passwordHash(nextPassword);
    this.data.auth.sessionSecret = encode(randomBytes(32));
    this.data.auth.updatedAt = new Date().toISOString();
    await this.save();
    return { username: nextUsername };
  }

  createSession(username = this.data.auth.username) {
    const expiresAt = Date.now() + this.sessionTtlDays * 24 * 60 * 60 * 1000;
    const payload = encode(JSON.stringify({ username, expiresAt }));
    const secret = decode(this.data.auth.sessionSecret);
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    return { token: `${payload}.${signature}`, maxAge: this.sessionTtlDays * 24 * 60 * 60 };
  }

  verifySession(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    try {
      const secret = decode(this.data.auth.sessionSecret);
      const expected = createHmac("sha256", secret).update(parts[0]).digest();
      const actual = Buffer.from(parts[1], "base64url");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (!payload.username || payload.username !== this.data.auth.username || Number(payload.expiresAt) <= Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async publicSettings() {
    const telegram = await this.getTelegramConfig();
    return {
      username: this.username,
      createdAt: this.createdAt,
      sessionTtlDays: this.sessionTtlDays,
      telegram: {
        configured: Boolean(telegram.token && telegram.chatId),
        chatId: maskChatId(telegram.chatId),
        apiBase: telegram.apiBase,
      },
    };
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return out;
}

export function sessionCookie(token, { secure = false, maxAge = 0 } = {}) {
  const parts = [
    `dw_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  if (maxAge > 0) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function clearSessionCookie({ secure = false } = {}) {
  return sessionCookie("", { secure, maxAge: 0 });
}
