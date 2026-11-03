// status.ts — status.json write for the waterbowl.
//
// The keeper writes a machine-readable status file that the persistent_*
// MCP tools and human operators read to understand keeper health at a glance
// (CDP reachable, pid, relaunch history, last error). Non-fatal on failure.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEEPER_DIR, STATUS_FILE, PROFILE_DIR } from "./config.js";

export interface KeeperStatus {
  cdp: string;
  pid: number | null;
  state: string;
  profile: string;
  started_at: string;
  relaunch_count: number;
  last_error: string | null;
  at: string;
}

export function writeStatus(opts: {
  cdp: string;
  childPid: number | null;
  state: string;
  startedAt: string;
  relaunchCount: number;
  lastError: string | null;
}, file: string = STATUS_FILE): void {
  const payload: KeeperStatus = {
    cdp: opts.cdp,
    pid: opts.childPid ?? process.pid,
    state: opts.state,
    profile: PROFILE_DIR,
    started_at: opts.startedAt,
    relaunch_count: opts.relaunchCount,
    last_error: opts.lastError,
    at: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(payload));
  } catch {
    /* non-critical */
  }
}

/** Cheap CDP liveness probe: GET /json/version, expect 200. */
export async function cdpAlive(cdpBase: string): Promise<boolean> {
  return fetch(`${cdpBase}/json/version`, {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.status === 200)
    .catch(() => false);
}
