import {
  clearRdapOverrides,
  formatDate,
  getBootstrapMap,
  getRdapOverrides,
  getTldList,
  isToday,
  loadOverridesFile,
  normalizeOverrideMap,
  normalizeRemindDays,
  parseDomains,
  queryDomain,
  setOverridesFile,
  setRdapOverrides,
  setStorageDir,
  setResultCacheTtlMinutes,
  getResultCacheTtlMinutes,
  getResultCacheInfo,
  RESULT_CACHE_MIN_MINUTES,
  RESULT_CACHE_MAX_MINUTES,
  RESULT_CACHE_DEFAULT_MINUTES,
} from "../src/domain-core.ts";
import { fail } from "./auth.mjs";

/** Configure the shared RDAP/WHOIS core for the standalone service. */
export function createDomainWatch({ dataDir }) {
  if (!dataDir) throw fail("invalid_data_dir", "dataDir is required");

  setStorageDir(dataDir);

  return {
    queryDomain,
    parseDomains,
    normalizeRemindDays,
    formatDate,
    isToday,
    // RDAP 映射覆盖（设置面板 + 外部 JSON 文件）
    getBootstrapMap,
    getTldList,
    setOverridesFile,
    setRdapOverrides,
    clearRdapOverrides,
    getRdapOverrides,
    loadOverridesFile,
    normalizeOverrideMap,
    // 查询结果缓存（时长可在设置面板调整）
    setResultCacheTtlMinutes,
    getResultCacheTtlMinutes,
    getResultCacheInfo,
    RESULT_CACHE_MIN_MINUTES,
    RESULT_CACHE_MAX_MINUTES,
    RESULT_CACHE_DEFAULT_MINUTES,
  };
}
