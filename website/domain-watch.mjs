import {
  formatDate,
  isToday,
  normalizeRemindDays,
  parseDomains,
  queryDomain,
  setStorageDir,
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
  };
}
