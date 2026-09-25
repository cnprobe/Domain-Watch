/**
 * Shared asynchronous domain lookup core.
 *
 * The Komari plugin and the standalone website both use this module. Komari
 * supplies __storageDir__; the website calls setStorageDir() explicitly.
 */

declare const require: (moduleName: string) => any;
declare const __storageDir__: string | undefined;

const fs = require("fs");
const path = require("path");
const { domainToASCII } = require("url");

let configuredStorageDir = "";

export function setStorageDir(directory: string): void {
  configuredStorageDir = String(directory || "");
}

function getStorageDir(): string {
  const directory = configuredStorageDir || (typeof __storageDir__ !== "undefined" ? __storageDir__ : "");
  if (!directory) throw new Error("storage directory is not configured");
  return directory;
}
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"; // IANA RDAP 引导文件（TLD → RDAP 服务器）
const UAPI_WHOIS_URL = "https://uapis.cn/api/v1/network/whois"; // UAPI WHOIS 查询（完整 API 地址，含 /api/v1 版本前缀；访客免费额度，无需 key）
const XXAPI_WHOIS_URL = "https://v2.xxapi.cn/api/whois"; // xxapi.cn 免费 WHOIS（文档页标注的接口，GET + domain 参数）
const BOOTSTRAP_TTL_MS = 72 * 60 * 60 * 1000; // 引导文件缓存有效期：72 小时
const BOOTSTRAP_TIMEOUT_MS = 15000; // 引导文件拉取超时
const RDAP_TIMEOUT_MS = 8000; // 单次 RDAP 查询超时
const WHOIS_PAGE_TIMEOUT_MS = 12000; // 单次 whois 回退查询超时（UAPI / 网页源）
const WHOIS_PAGE_SOURCES: Array<{ name: string; url: (d: string) => string }> = [
  { name: "who.is", url: (d) => "https://who.is/whois/" + d },
  { name: "whois.com", url: (d) => "https://www.whois.com/whois/" + d },
];
const BOOTSTRAP_FILE = "rdap-bootstrap.json"; // 引导文件磁盘缓存名
const DEFAULT_REMIND_DAYS = 30;
// ---------- 类型 ----------
type BootstrapMap = Record<string, string[]>;
interface AppError extends Error {
  code?: string;
}
interface ErrorBody {
  code: string;
  message: string;
}
type QueryOutcome =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: ErrorBody };

// ---------- 内存状态 ----------
let bootstrapMap: BootstrapMap | null = null; // 解析后的引导映射 { tld: [rdapUrl, ...] }
let bootstrapFetchedAt = 0;
let bootstrapLoading: Promise<BootstrapMap> | null = null; // 进行中的引导加载（避免并发重复拉取）
/** 构造带 code 属性的 Error，code 用于归类错误 */
function makeError(code: string, message: string): AppError {
  const err = new Error(message) as AppError;
  err.code = code;
  return err;
}

/** 统一错误转响应结构 */
function errToResponse(err: unknown): { ok: false; error: ErrorBody } {
  const e = err as AppError;
  const code = e && e.code ? e.code : "unknown";
  const message = e && e.message ? e.message : String(err);
  return { ok: false, error: { code, message } };
}

/** 带超时的 fetch，返回解析后的 JSON；超时/网络/解析错误抛带 code 的 Error */
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, Object.assign({ signal: controller.signal }, init));
  } catch (err) {
    const e = err as any;
    if (e && (e.name === "AbortError" || /abort/i.test(String(e.name || "")))) {
      throw makeError("timeout", "请求超时：" + url);
    }
    throw makeError("network_error", "网络错误：" + (e && e.message ? e.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text(); // body 完整缓冲（上限 32MiB）
  // RFC 7480：404 即域名未注册（部分服务器 404 响应体不是 JSON，先判状态码）
  if (res.status === 404) {
    throw makeError("not_found", "未找到该域名的注册信息（HTTP 404）");
  }
  if (!res.ok) {
    throw makeError("http_error", "HTTP " + res.status + "：" + url);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw makeError("parse_error", "响应不是有效的 JSON（HTTP " + res.status + "）：" + url);
  }
  return json;
}

/** 带超时的 fetch，返回原始文本（用于 whois 网页回退）；超时/网络错误抛带 code 的 Error */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const e = err as any;
    if (e && (e.name === "AbortError" || /abort/i.test(String(e.name || "")))) {
      throw makeError("timeout", "请求超时：" + url);
    }
    throw makeError("network_error", "网络错误：" + (e && e.message ? e.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw makeError("http_error", "HTTP " + res.status + "：" + url);
  }
  return res.text();
}

/** 拼接 RDAP URL：确保 base 以 / 结尾 */
function joinUrl(base: string, part1: string, part2: string): string {
  let b = String(base);
  if (!b.endsWith("/")) b += "/";
  return b + part1 + "/" + part2;
}

/** 格式化到期日为 YYYY-MM-DD（UTC） */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : "" + n);
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

/** 判断 ISO 时间字符串的日期部分是否为今天（本地时区） */
function isToday(isoStr: string): boolean {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// ---------- 域名归一化与校验 ----------

/** 清洗用户输入：去 scheme、路径/查询/锚点、端口、尾点、空白，转小写 */
function normalizeDomainInput(input: string): string {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // 去掉 http(s):// 等 scheme
  const cut = s.search(/[/?#]/); // 去掉路径/查询/锚点
  if (cut !== -1) s = s.slice(0, cut);
  s = s.replace(/:\d+$/, ""); // 去掉端口
  while (s.endsWith(".")) s = s.slice(0, -1);
  return s.trim();
}

/** IDN 转 punycode 并校验格式；非法域名抛 invalid_domain */
function toAsciiDomain(domain: string): string {
  let ascii: string;
  try {
    ascii = domainToASCII(domain).toLowerCase();
  } catch (e) {
    throw makeError("invalid_domain", "无效的域名：" + domain);
  }
  // 至少两段（有 TLD），每段字母数字开头结尾、中间可含连字符
  if (
    ascii.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(ascii)
  ) {
    throw makeError("invalid_domain", "无效的域名：" + domain);
  }
  return ascii;
}

/**
 * 生成 TLD 候选后缀（从最长到最短）。
 * 例如 "sub.example.co.uk" → ["example.co.uk", "co.uk", "uk"]
 * 引导文件中 "co.uk" 与 "uk" 同时存在时优先匹配更具体的 "co.uk"
 */
function getTldCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 1; i < labels.length; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/** 解析配置中的域名列表：兼容中英文逗号/分号/空白分隔，去重 */
function parseDomains(value: string): string[] {
  const out: string[] = [];
  const seen: Record<string, number> = {};
  const parts = String(value || "").split(/[,，;；\s]+/);
  for (let i = 0; i < parts.length; i++) {
    const d = normalizeDomainInput(parts[i]);
    if (!d) continue;
    let ascii: string;
    try {
      ascii = toAsciiDomain(d);
    } catch (e) {
      console.log("[domain-watch] 忽略无效的域名配置项：" + parts[i]);
      continue;
    }
    if (!seen[ascii]) {
      seen[ascii] = 1;
      out.push(ascii);
    }
  }
  return out;
}

/** 归一化提醒天数：非法值回退 30，限制 0~365 */
function normalizeRemindDays(value: unknown): number {
  const n = Number(value);
  if (isNaN(n)) return DEFAULT_REMIND_DAYS;
  return Math.max(0, Math.min(365, Math.floor(n)));
}

// ---------- IANA RDAP 引导文件 ----------

/** 解析 dns.json 为 { tld: [urls] } */
function parseBootstrap(data: any): BootstrapMap {
  if (!data || !Array.isArray(data.services)) {
    throw makeError("parse_error", "bootstrap 文件格式错误");
  }
  const map: BootstrapMap = {};
  for (let i = 0; i < data.services.length; i++) {
    const entry = data.services[i];
    const tlds: string[] = Array.isArray(entry) && Array.isArray(entry[0]) ? entry[0] : [];
    const urls: string[] = Array.isArray(entry) && Array.isArray(entry[1]) ? entry[1] : [];
    for (let j = 0; j < tlds.length; j++) {
      const key = String(tlds[j]).toLowerCase();
      if (!map[key]) map[key] = [];
      for (let k = 0; k < urls.length; k++) {
        if (map[key].indexOf(urls[k]) === -1) map[key].push(urls[k]);
      }
    }
  }
  return map;
}

/**
 * 获取引导映射（内存 → 磁盘缓存 → 远程拉取）。
 * 远程拉取失败时回退过期缓存，避免插件不可用
 */
function getBootstrapMap(): Promise<BootstrapMap> {
  if (bootstrapMap && bootstrapFetchedAt && Date.now() - bootstrapFetchedAt < BOOTSTRAP_TTL_MS) {
    return Promise.resolve(bootstrapMap);
  }
  if (bootstrapLoading) return bootstrapLoading;
  bootstrapLoading = loadBootstrap().finally(function () { bootstrapLoading = null; });
  return bootstrapLoading;
}

async function loadBootstrap(): Promise<BootstrapMap> {
  const file = path.join(getStorageDir(), BOOTSTRAP_FILE);
  let cachedMap: BootstrapMap | null = null;
  // 1) 尝试磁盘缓存
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const data = JSON.parse(raw);
    if (data && data.map && typeof data.map === "object") {
      cachedMap = data.map as BootstrapMap;
      bootstrapFetchedAt = Number(data.fetchedAt) || 0;
      if (bootstrapFetchedAt && Date.now() - bootstrapFetchedAt < BOOTSTRAP_TTL_MS) {
        bootstrapMap = cachedMap;
        console.log("[domain-watch] 引导文件命中缓存（" + Object.keys(cachedMap).length + " 个 TLD）");
        return cachedMap;
      }
    }
  } catch (e) {
    // 无缓存或缓存损坏，继续拉取
  }
  // 2) 远程拉取
  try {
    const data = await fetchJson(BOOTSTRAP_URL, { headers: { Accept: "application/json" } }, BOOTSTRAP_TIMEOUT_MS);
    const map = parseBootstrap(data);
    bootstrapMap = map;
    bootstrapFetchedAt = Date.now();
    try {
      await fs.promises.writeFile(file, JSON.stringify({ fetchedAt: bootstrapFetchedAt, map: map }));
    } catch (writeError) {
      // 缓存写入失败不应影响本次查询
      console.log("[domain-watch] 引导文件缓存写入失败：" + ((writeError as AppError).message || writeError));
    }
    console.log("[domain-watch] 引导文件已更新（" + Object.keys(map).length + " 个 TLD）");
    return map;
  } catch (err) {
    // 3) 拉取失败 → 回退过期缓存；否则抛错
    if (cachedMap) bootstrapMap = cachedMap;
    if (bootstrapMap) {
      bootstrapFetchedAt = Date.now();
      console.log("[domain-watch] 引导文件拉取失败，使用过期缓存：" + ((err as AppError).message || (err as AppError).code));
      return bootstrapMap;
    }
    throw makeError("bootstrap_error", "无法获取 RDAP 引导文件：" + ((err as AppError).message || (err as AppError).code));
  }
}

// ---------- RDAP 查询 ----------

/** 从 RDAP 数据中提取注册商（entities 中 role=registrar 的 vcard fn / handle） */
function extractRegistrar(data: any): { handle: string | null; name: string } | null {
  const entities = Array.isArray(data.entities) ? data.entities : [];
  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i];
    const roles: string[] = Array.isArray(ent.roles) ? ent.roles : [];
    if (roles.indexOf("registrar") === -1) continue;
    const name = findVcardFn(ent.vcardArray);
    const handle = ent.handle ? String(ent.handle) : null;
    return { handle: handle, name: name || handle || "" };
  }
  return null;
}

/** 从 vcardArray 中取 fn 字段值 */
function findVcardFn(vcardArray: any): string | null {
  try {
    if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
    const items = vcardArray[1];
    if (!Array.isArray(items)) return null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item[0] === "fn" && item[3] != null) return String(item[3]);
    }
  } catch (e) {
    // 忽略解析错误
  }
  return null;
}

/** 提取 nameserver 列表（优先 data.nameservers，兜底 entities role=nameserver） */
function extractNameservers(data: any): string[] {
  const out: string[] = [];
  if (Array.isArray(data.nameservers)) {
    for (let i = 0; i < data.nameservers.length; i++) {
      const ns = data.nameservers[i];
      const name = ns && (ns.ldhName || ns.fqdn || ns.unicodeName || ns.handle);
      if (name) out.push(String(name));
    }
  }
  if (out.length === 0 && Array.isArray(data.entities)) {
    for (let i = 0; i < data.entities.length; i++) {
      const ent = data.entities[i];
      const roles: string[] = Array.isArray(ent.roles) ? ent.roles : [];
      if (roles.indexOf("nameserver") === -1) continue;
      const name = findVcardFn(ent.vcardArray) || (ent.handle ? String(ent.handle) : "");
      if (name) out.push(String(name));
    }
  }
  return out;
}

/** 从 events 数组中提取注册/到期/变更时间 */
function extractEvents(data: any): Record<string, string> {
  const events: Record<string, string> = {};
  const raw = Array.isArray(data.events) ? data.events : [];
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i];
    if (!ev || !ev.eventAction || !ev.eventDate) continue;
    events[ev.eventAction] = ev.eventDate;
  }
  return events;
}

/** 组装最终结构化结果 */
function buildResult(asciiDomain: string, inputDomain: string, tld: string, rdapServer: string, data: any): Record<string, unknown> {
  const events = extractEvents(data);
  return {
    ok: true,
    domain: inputDomain, // 用户输入的原始域名
    asciiDomain: asciiDomain, // punycode 后的 ASCII 域名
    tld: tld, // 命中的 TLD 后缀（如 com / co.uk）
    rdapServer: rdapServer, // 实际使用的 RDAP 服务器
    source: "rdap", // 标识数据来源：rdap | whois
    ldhName: data.ldhName || asciiDomain,
    unicodeName: data.unicodeName || null, // 注册局返回的 Unicode 形式（如有）
    registration: events["registration"] || null, // 注册时间
    expiration: events["expiration"] || null, // 到期时间
    lastChanged: events["last changed"] || events["lastChanged"] || null, // 最近变更时间
    registrar: extractRegistrar(data), // { handle, name }
    nameservers: extractNameservers(data), // [ns1.example.com, ...]
    status: Array.isArray(data.status) ? data.status : [], // RDAP 状态码
    dnssec: data.secureDNS && typeof data.secureDNS === "object" ? data.secureDNS : null, // { delegationSigned, dsData }
    events: events, // 全部原始事件（eventAction → eventDate）
  };
}

/**
 * 匹配 TLD 引导：返回 { tld, urls, candidates }。
 * candidates 按从长到短排列，引导文件中更具体的后缀优先
 */
function resolveTld(map: BootstrapMap, ascii: string): { tld: string; urls: string[]; candidates: string[] } {
  const candidates = getTldCandidates(ascii);
  for (let i = 0; i < candidates.length; i++) {
    if (map[candidates[i]]) {
      return { tld: candidates[i], urls: map[candidates[i]], candidates };
    }
  }
  return { tld: "", urls: [], candidates };
}

/**
 * 完整查询流程：归一化 → IDN 转 punycode → 匹配 TLD 引导 → RDAP 查询 → 结构化结果。
 * 抛错（带 code）：invalid_domain / not_found / timeout / network_error / http_error / parse_error / ...
 */
async function queryDomain(domain: string): Promise<Record<string, unknown>> {
  const input = normalizeDomainInput(domain);
  if (!input) throw makeError("invalid_domain", "缺少 domain 参数");
  const ascii = toAsciiDomain(input);
  const map = await getBootstrapMap();
  // 按候选后缀从长到短匹配引导文件
  const resolved = resolveTld(map, ascii);
  const { tld, urls } = resolved;
  if (!urls || urls.length === 0) {
    // 该 TLD 无 RDAP 服务（常见于 ccTLD，如 .cn/.jp/.de）→ 回退 whois 网页查询
    const fallbackTld = resolved.candidates[resolved.candidates.length - 1] || ascii;
    console.log("[domain-watch] " + ascii + " 的 TLD " + fallbackTld + " 无 RDAP 服务，回退 whois");
    return queryWhoisFallback(ascii, input, fallbackTld);
  }
  // 按优先级尝试该 TLD 的多个 RDAP 服务器（备用地址兜底）
  let lastErr: unknown = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      const url = joinUrl(urls[i], "domain", ascii);
      const data = await fetchJson(url, { headers: { Accept: "application/rdap+json, application/json" } }, RDAP_TIMEOUT_MS);
      // RFC 7483：错误对象（404 等）或无 objectClassName 的响应视为未找到
      if (!data || data.objectClassName !== "domain") {
        throw makeError("not_found", "未找到该域名的注册信息");
      }
      return buildResult(ascii, input, tld, urls[i], data);
    } catch (err) {
      lastErr = err;
      if ((err as AppError).code === "not_found" || (err as AppError).code === "invalid_domain") throw err; // 确定性错误，不再试备用
      console.log("[domain-watch] RDAP 服务器 " + urls[i] + " 查询失败: " + ((err as AppError).message || (err as AppError).code));
    }
  }
  // 所有 RDAP 服务器均失败 → 回退 whois 网页查询
  console.log("[domain-watch] " + ascii + " 的 RDAP 查询全部失败（" + ((lastErr as AppError).message || (lastErr as AppError).code) + "），回退 whois");
  return queryWhoisFallback(ascii, input, tld);
}

// ---------- WHOIS 网页回退查询 ----------
//
// 背景：并非所有 TLD 都提供 RDAP（IANA dns.json 只覆盖部分 gTLD/ccTLD，
// 如 .cn/.jp/.de/.ru/.kr/.hk/.vn/.us/.io 等常用 ccTLD 均无 RDAP）。
// 沙箱无 TCP socket（无法直连 whois 43 端口明文协议），因此回退方案为抓取
// whois 网页服务（who.is / whois.com）的 HTML 并解析字段，结果结构与 RDAP 对齐。

/** 从 whois 网页 HTML 中解析结构化字段（兼容 whois.com 的 <pre> 与 who.is 的脚本 JSON） */
function parseWhoisHtml(html: string): {
  registration: string | null;
  expiration: string | null;
  lastChanged: string | null;
  registrar: { handle: string | null; name: string } | null;
  nameservers: string[];
  status: string[];
} {
  // 优先取 <pre> 内容（whois.com 的 registryData 块），否则用整页文本
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  let text = preMatch ? preMatch[1] : html;
  // 还原转义：\\n / \n -> 换行（who.is 的 JSON 文本是双重转义，先处理双层再处理单层）、HTML 实体、去掉残留标签
  text = text
    .replace(/\\\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const lines = text.split("\n");
  const field = (name: string): string | null => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(new RegExp("^\\s*" + name + "\\s*:\\s*(.+)$", "i"));
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  };
  const fields = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(new RegExp("^\\s*" + name + "\\s*:\\s*(.+)$", "i"));
      if (m && m[1].trim()) {
        const v = m[1].trim();
        if (out.indexOf(v) === -1) out.push(v);
      }
    }
    return out;
  };
  const registrarName = field("Sponsoring Registrar") || field("Registrar");
  const registration = field("Registration Time") || field("Creation Date") || field("Registered On") || field("Created On");
  const expiration = field("Expiration Time") || field("Expiry Date") || field("Registry Expiry Date") || field("Expires On") || field("Expiration Date");
  const lastChanged = field("Updated Date") || field("Last Updated") || field("Updated On");
  let nameservers = fields("Name Server");
  if (nameservers.length === 0) nameservers = fields("Nameserver");
  let status = fields("Domain Status");
  if (status.length === 0) status = fields("Status");
  return {
    registration: registration,
    expiration: expiration,
    lastChanged: lastChanged,
    registrar: registrarName ? { handle: null, name: registrarName } : null,
    nameservers: nameservers,
    status: status,
  };
}

/** 组装 whois 回退结果（字段结构与 RDAP 对齐，source 标识来源） */
function buildWhoisResult(
  asciiDomain: string,
  inputDomain: string,
  tld: string,
  whoisServer: string,
  parsed: {
    registration: string | null;
    expiration: string | null;
    lastChanged: string | null;
    registrar: { handle: string | null; name: string } | null;
    nameservers: string[];
    status: string[];
  }
): Record<string, unknown> {
  const events: Record<string, string> = {};
  if (parsed.registration) events["registration"] = parsed.registration;
  if (parsed.expiration) events["expiration"] = parsed.expiration;
  if (parsed.lastChanged) events["last changed"] = parsed.lastChanged;
  return {
    ok: true,
    domain: inputDomain,
    asciiDomain: asciiDomain,
    tld: tld,
    rdapServer: null,
    source: "whois", // 标识数据来源：rdap | whois
    whoisServer: whoisServer,
    ldhName: asciiDomain,
    unicodeName: null,
    registration: parsed.registration,
    expiration: parsed.expiration,
    lastChanged: parsed.lastChanged,
    registrar: parsed.registrar,
    nameservers: parsed.nameservers,
    status: parsed.status,
    dnssec: null,
    events: events,
  };
}

// ---------- xxapi.cn WHOIS 查询（首选免费回退源） ----------
//
// 完整 API 地址：https://v2.xxapi.cn/api/whois?domain=xxx（xxapi.cn/markdown/whois 为文档页，
// 文档内标注的真实接口地址，免费无 key，数据缓存 3 天）。返回 { code, msg, data } 结构。

/** 将 xxapi.cn 结构化 data 映射为插件标准结果 */
function buildXxapiResult(asciiDomain: string, inputDomain: string, tld: string, data: any): Record<string, unknown> {
  const d = data && typeof data === "object" ? data : {};
  const nested = d.data && typeof d.data === "object" ? d.data : {};
  const pick = (keys: string[]): string | null => {
    for (let i = 0; i < keys.length; i++) {
      const v = d[keys[i]] != null ? d[keys[i]] : nested[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  // 清理脏数据：Registration Time 值可能带 "Registration Time: " 前缀
  const cleanTime = (s: string | null): string | null => {
    if (!s) return null;
    let t = String(s).replace(/^[^:]+:\s*/, "");
    t = t.trim();
    return t || null;
  };
  const registration = cleanTime(pick(["Registration Time", "registration_time", "Creation Date", "created_date"]));
  const expiration = pick(["Expiration Time", "expiration_time", "Expiry Date", "expiration_date"]);
  const lastChanged = pick(["Updated Date", "updated_date", "Update Date", "update_date"]);
  const registrarName = pick(["Sponsoring Registrar", "sponsoring_registrar", "Registrar", "registrar"]);
  const nsRaw = pick(["DNS Serve", "dns_serve", "Name Server", "name_server"]);
  const stRaw = pick(["domain_status", "Domain Status", "status"]);
  const nameservers = nsRaw ? nsRaw.split(/[\s,]+/).filter(Boolean) : [];
  const status = stRaw ? stRaw.split(/[\s,]+/).filter(Boolean) : [];
  // xxapi 对某些 TLD（如 .de）会返回空壳记录（code:200 但字段全空）→ 视为无有效数据，抛出使回退链继续下源
  if (!registration && !expiration && !lastChanged && !registrarName && nameservers.length === 0 && status.length === 0) {
    throw makeError("parse_error", "xxapi.cn 返回空数据：" + asciiDomain);
  }
  const events: Record<string, string> = {};
  if (registration) events["registration"] = registration;
  if (expiration) events["expiration"] = expiration;
  if (lastChanged) events["last changed"] = lastChanged;
  return {
    ok: true,
    domain: inputDomain,
    asciiDomain: asciiDomain,
    tld: tld,
    rdapServer: null,
    source: "whois",
    whoisServer: "xxapi.cn",
    ldhName: asciiDomain,
    unicodeName: null,
    registration: registration,
    expiration: expiration,
    lastChanged: lastChanged,
    registrar: registrarName ? { handle: null, name: registrarName } : null,
    nameservers: nameservers,
    status: status,
    dnssec: null,
    events: events,
  };
}

/** 异步调用 xxapi.cn WHOIS；失败抛带 code 的 Error */
async function queryXxapiWhois(asciiDomain: string, inputDomain: string, tld: string): Promise<Record<string, unknown>> {
  const url = XXAPI_WHOIS_URL + "?domain=" + encodeURIComponent(asciiDomain);
  const json = await fetchJson(url, { headers: { Accept: "application/json" } }, WHOIS_PAGE_TIMEOUT_MS);
  if (!json || json.code !== 200) {
    throw makeError("http_error", "xxapi.cn 返回错误（code " + (json && json.code) + "）：" + (json && json.msg ? json.msg : url));
  }
  return buildXxapiResult(asciiDomain, inputDomain, tld, json.data);
}

// ---------- UAPI WHOIS 查询（第二备选，访客免费额度） ----------
//
// 完整 API 地址：https://uapis.cn/api/v1/network/whois?domain=xxx&format=json
// 鉴权：访客免费额度，无需 key，每月 1500 次
// 错误码：400 INVALID_ARGUMENT / 404 NOT_FOUND / 429 VISITOR_MONTHLY_QUOTA_EXHAUSTED / 402 INSUFFICIENT_CREDITS

/** 将 UAPI 结构化 whois 映射为插件标准结果（字段与 buildWhoisResult 对齐） */
function buildUapiResult(asciiDomain: string, inputDomain: string, tld: string, whois: any): Record<string, unknown> {
  const dom = whois && typeof whois === "object" ? whois.domain : null;
  const registrar = whois && typeof whois === "object" ? whois.registrar : null;
  const events: Record<string, string> = {};
  const registration = dom && (dom.created_date_in_time || dom.created_date || null);
  const expiration = dom && (dom.expiration_date_in_time || dom.expiration_date || null);
  const lastChanged = dom && (dom.updated_date_in_time || dom.updated_date || null);
  const nameservers = Array.isArray(dom && dom.name_servers) ? dom.name_servers.map(String) : [];
  const status = Array.isArray(dom && dom.status) ? dom.status.map(String) : [];
  // UAPI 对某些后缀同样可能返回空壳记录 → 判空抛错，使回退链继续走网页源
  if (!registration && !expiration && !lastChanged && !(registrar && registrar.name) && nameservers.length === 0 && status.length === 0) {
    throw makeError("parse_error", "UAPI 返回空数据：" + asciiDomain);
  }
  if (registration) events["registration"] = String(registration);
  if (expiration) events["expiration"] = String(expiration);
  if (lastChanged) events["last changed"] = String(lastChanged);
  return {
    ok: true,
    domain: inputDomain,
    asciiDomain: asciiDomain,
    tld: dom && dom.extension ? String(dom.extension) : tld,
    rdapServer: null,
    source: "whois",
    whoisServer: "uapis.cn",
    ldhName: asciiDomain,
    unicodeName: null,
    registration: registration != null ? String(registration) : null,
    expiration: expiration != null ? String(expiration) : null,
    lastChanged: lastChanged != null ? String(lastChanged) : null,
    registrar:
      registrar && registrar.name
        ? { handle: registrar.id != null ? String(registrar.id) : null, name: String(registrar.name) }
        : null,
    nameservers: nameservers,
    status: status,
    dnssec: null,
    events: events,
  };
}

/** 异步调用 UAPI WHOIS（format=json）；失败抛带 code 的 Error */
async function queryUapiWhois(asciiDomain: string, inputDomain: string, tld: string): Promise<Record<string, unknown>> {
  const url = UAPI_WHOIS_URL + "?domain=" + encodeURIComponent(asciiDomain) + "&format=json";
  const headers: Record<string, string> = { Accept: "application/json" }; // 访客免费额度，无需鉴权
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOIS_PAGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: headers });
  } catch (err) {
    const e = err as any;
    if (e && (e.name === "AbortError" || /abort/i.test(String(e.name || "")))) {
      throw makeError("timeout", "请求超时：" + url);
    }
    throw makeError("network_error", "网络错误：" + (e && e.message ? e.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (res.status === 200) {
    const whois = json && json.whois;
    if (!whois || typeof whois !== "object") {
      throw makeError("parse_error", "UAPI 响应缺少 whois 字段：" + url);
    }
    return buildUapiResult(asciiDomain, inputDomain, tld, whois);
  }
  // 非 2xx：优先取响应体中的 code/message，否则按 HTTP 状态归类
  const code = json && json.code ? String(json.code) : "";
  const message = json && json.message ? String(json.message) : ("HTTP " + res.status + "：" + url);
  if (res.status === 400) throw makeError("invalid_argument", message); // 参数无效（不重试）
  if (res.status === 404) throw makeError("not_found", message); // 域名不存在（不重试）
  if (res.status === 429) throw makeError("rate_limited", "UAPI 限流（" + (code || "429") + "）：" + message); // 访客月额度耗尽
  if (res.status === 402) throw makeError("insufficient_credits", "UAPI 积分不足（" + (code || "402") + "）：" + message);
  throw makeError("http_error", "HTTP " + res.status + "（" + code + "）：" + message);
}

/** 异步 whois 回退链：xxapi.cn → UAPI（访客）→ 网页源，全部失败抛错 */
async function queryWhoisFallback(asciiDomain: string, inputDomain: string, tld: string): Promise<Record<string, unknown>> {
  // 1) 首选 xxapi.cn（免费，结构化 JSON）
  try {
    const r = await queryXxapiWhois(asciiDomain, inputDomain, tld);
    console.log("[domain-watch] whois 回退成功（xxapi.cn）：" + asciiDomain);
    return r;
  } catch (e1) {
    const c1 = (e1 as AppError).code;
    if (c1 === "not_found" || c1 === "invalid_argument") throw e1;
    console.log("[domain-watch] xxapi.cn 失败（" + c1 + "）: " + ((e1 as AppError).message || String(e1)));
  }
  // 2) UAPI（访客免费额度）
  try {
    const r = await queryUapiWhois(asciiDomain, inputDomain, tld);
    console.log("[domain-watch] whois 回退成功（UAPI 访客）：" + asciiDomain);
    return r;
  } catch (e2) {
    const c2 = (e2 as AppError).code;
    if (c2 === "not_found" || c2 === "invalid_argument") throw e2;
    console.log("[domain-watch] UAPI 失败（" + c2 + "），改用网页源: " + ((e2 as AppError).message || String(e2)));
  }
  // 3) 网页源兜底（who.is / whois.com）
  let lastErr: unknown = null;
  for (let i = 0; i < WHOIS_PAGE_SOURCES.length; i++) {
    const src = WHOIS_PAGE_SOURCES[i];
    try {
      const url = src.url(asciiDomain);
      const html = await fetchText(url, WHOIS_PAGE_TIMEOUT_MS);
      const parsed = parseWhoisHtml(html);
      if (!parsed.registration && !parsed.expiration && parsed.nameservers.length === 0) {
        throw makeError("parse_error", "未解析到有效 whois 字段：" + src.name);
      }
      return buildWhoisResult(asciiDomain, inputDomain, tld, src.name, parsed);
    } catch (err) {
      lastErr = err;
      console.log("[domain-watch] whois 网页源 " + src.name + " 失败: " + ((err as AppError).message || (err as AppError).code));
    }
  }
  throw lastErr || makeError("network_error", "所有 whois 回退源均不可用");
}

/** 查询入口的封装：任何异常都转成 ok:false 响应结构 */
async function safeQuery(domain: string): Promise<QueryOutcome> {
  try {
    return (await queryDomain(domain)) as QueryOutcome;
  } catch (err) {
    return errToResponse(err);
  }
}

export {
  buildResult,
  buildUapiResult,
  buildXxapiResult,
  errToResponse,
  formatDate,
  getBootstrapMap,
  isToday,
  joinUrl,
  makeError,
  normalizeDomainInput,
  normalizeRemindDays,
  parseBootstrap,
  parseDomains,
  queryDomain,
  resolveTld,
  safeQuery,
  toAsciiDomain,
};
