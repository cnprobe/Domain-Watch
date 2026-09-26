/**
 * 登录暴力破解防护
 *
 * 单用户部署下，攻击者的目标只有一个账号，因此需要两层同时生效：
 *   - 按来源 IP 限制：挡住同一来源的反复尝试
 *   - 按账号限制：挡住换 IP / 换 IPv6 地址的分布式字典攻击
 *
 * 两层的失败计数都会在窗口结束后自动过期，登录成功也会一并清零；
 * 全部状态只存在内存里，进程重启即失效（刻意不落盘，避免锁死无法登录）。
 */

/** @typedef {{ failures: number; startedAt: number }} FailureRecord */

export const DEFAULT_POLICY = {
  /** 单个 IP 的失败次数上限 */
  ipMaxFailures: 5,
  /** 单个 IP 的统计窗口 */
  ipWindowMs: 15 * 60 * 1000,
  /** 同一账号（跨所有来源 IP）的失败次数上限 */
  accountMaxFailures: 10,
  /** 账号级统计窗口，比 IP 级更长，用来拖慢分布式字典攻击 */
  accountWindowMs: 30 * 60 * 1000,
  /** 每个 Map 最多跟踪多少个键，防止用随机用户名/IP 灌爆内存 */
  maxTrackedKeys: 512,
};

/** 账号键：大小写与空白归一，避免 `Admin`、`admin ` 被算成不同账号 */
export function accountKey(username) {
  return String(username ?? "").trim().toLowerCase().slice(0, 64) || "(空)";
}

/**
 * 归一化来源地址：
 * - 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 与 1.2.3.4 视为同一来源）
 * - 只接受看起来像 IP 的值，避免伪造头产生无限多不同的键
 */
export function normalizeIp(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text || text.length > 45) return "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return text;
  if (/^[0-9a-f:]{2,45}$/.test(text) && text.includes(":")) return text;
  return "";
}

export function createLoginGuard(policy = {}, now = () => Date.now()) {
  const config = { ...DEFAULT_POLICY, ...policy };
  /** @type {Map<string, FailureRecord>} */
  const byIp = new Map();
  /** @type {Map<string, FailureRecord>} */
  const byAccount = new Map();

  /** 丢弃窗口已过的记录；仍超容量时按最近使用顺序淘汰，避免被随机键灌爆 */
  function enforceLimit(map, windowMs) {
    const at = now();
    for (const [key, record] of map) {
      if (at - record.startedAt > windowMs) map.delete(key);
    }
    while (map.size > config.maxTrackedKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function hit(map, key, windowMs) {
    const at = now();
    const record = map.get(key);
    if (!record || at - record.startedAt > windowMs) {
      map.delete(key);
      map.set(key, { failures: 1, startedAt: at });
      return 1;
    }
    record.failures += 1;
    // 重新插入让它排到队尾，容量淘汰时先动最久没用的键
    map.delete(key);
    map.set(key, record);
    return record.failures;
  }

  /** 记录一次失败，返回该来源/账号累计失败次数 */
  function recordFailure({ ip, username }) {
    const ipKey = ip || "unknown";
    const ipFailures = hit(byIp, ipKey, config.ipWindowMs);
    const accountFailures = hit(byAccount, accountKey(username), config.accountWindowMs);
    if (byIp.size > config.maxTrackedKeys) enforceLimit(byIp, config.ipWindowMs);
    if (byAccount.size > config.maxTrackedKeys) enforceLimit(byAccount, config.accountWindowMs);
    return { ipFailures, accountFailures };
  }

  /** 锁定剩余毫秒数，0 表示未锁定 */
  function lockedFor(map, key, windowMs, maxFailures) {
    const record = map.get(key);
    if (!record) return 0;
    const elapsed = now() - record.startedAt;
    if (elapsed > windowMs) {
      map.delete(key);
      return 0;
    }
    if (record.failures < maxFailures) return 0;
    return Math.max(0, windowMs - elapsed);
  }

  /**
   * 检查是否放行。`layer` 只用于服务端日志，响应体不区分层次，
   * 避免攻击者通过错误码判断「账号被锁」还是「IP 被锁」。
   */
  function check({ ip, username }) {
    const byIpLocked = lockedFor(byIp, ip || "unknown", config.ipWindowMs, config.ipMaxFailures);
    if (byIpLocked > 0) return { allowed: false, layer: "ip", retryAfterMs: byIpLocked };
    const byAccountLocked = lockedFor(byAccount, accountKey(username), config.accountWindowMs, config.accountMaxFailures);
    if (byAccountLocked > 0) return { allowed: false, layer: "account", retryAfterMs: byAccountLocked };
    return { allowed: true, layer: "", retryAfterMs: 0 };
  }

  function recordSuccess({ ip, username }) {
    byIp.delete(ip || "unknown");
    byAccount.delete(accountKey(username));
  }

  /** 仅供测试与只读展示 */
  function snapshot() {
    return { trackedIps: byIp.size, trackedAccounts: byAccount.size };
  }

  function reset() {
    byIp.clear();
    byAccount.clear();
  }

  return { recordFailure, recordSuccess, check, snapshot, reset, policy: Object.freeze({ ...config }) };
}
