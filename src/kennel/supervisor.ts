// supervisor.ts — keeper supervisor loop.
//
// Owns the chromium child's lifecycle: spawn -> health-probe (/json/version)
// -> respawn on death -> graceful shutdown on SIGTERM/SIGINT. This is the
// "keeper loop" that was previously inlined into bin/keeper.ts; extracting it
// keeps the binary a thin entry and makes the loop independently testable.

import { cdpAlive, writeStatus } from "./status.js";
import { CDP_BASE, CDP_PORT, PROFILE_DIR } from "./config.js";

export interface ManagedChild {
  pid: number;
  kill(): void;
  exitCode: number | null;
}

export interface SupervisorHooks {
  /** Spawn a fresh chromium child, or null if spawning failed. */
  spawn(): ManagedChild | null;
  /** Current shutdown request state (true once SIGTERM/SIGINT handled). */
  stopRequested(): boolean;
  /** Called once the loop has fully drained and before returning. */
  onStopped?(): void;
}

export interface SupervisorOptions {
  /** CDP health probe; defaults to the real /json/version fetch. */
  cdpProbe?(base: string): Promise<boolean>;
  /** Status file path; defaults to the shared keeper STATUS_FILE. */
  statusFile?: string;
  /** Test/operator tuning for the supervision loop timings. */
  heartbeatMs?: number;
  launchProbeMs?: number;
  launchProbes?: number;
  recycleGraceMs?: number;
  maxBackoffMs?: number;
}

const HEARTBEAT_MS = 10_000;
const LAUNCH_PROBE_MS = 500;
const LAUNCH_PROBES = 20;
const RECYCLE_GRACE_MS = 1500;
const MAX_BACKOFF_MS = 120_000;

const log = (...a: unknown[]) =>
  console.log(new Date().toISOString(), "[keeper]", ...a);
const sleep = (ms: number) => Bun.sleep(ms);
const STARTED_AT = new Date().toISOString();

/**
 * Run the supervisor until `stopRequested()` returns true. Blocks; the caller
 * installs process signal handlers that flip the stop flag.
 */
export async function runSupervisor(
  hooks: SupervisorHooks,
  opts: SupervisorOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const launchProbeMs = opts.launchProbeMs ?? LAUNCH_PROBE_MS;
  const launchProbes = opts.launchProbes ?? LAUNCH_PROBES;
  const recycleGraceMs = opts.recycleGraceMs ?? RECYCLE_GRACE_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const cdpProbe = opts.cdpProbe ?? cdpAlive;
  let relaunchCount = 0;
  let lastError: string | null = null;

  const status = (state: string, pid: number | null) =>
    writeStatus({
      cdp: CDP_BASE,
      childPid: pid,
      state,
      startedAt: STARTED_AT,
      relaunchCount,
      lastError,
    }, opts.statusFile);

  status("starting", null);

  while (!hooks.stopRequested()) {
    const child = hooks.spawn();
    if (!child) {
      lastError = "spawn failed";
      status("failed", null);
      const delay = Math.min(
        maxBackoffMs,
        launchProbeMs * 2 ** Math.min(relaunchCount, 5),
      );
      relaunchCount++;
      for (
        let i = 0;
        i < Math.ceil(delay / launchProbeMs) && !hooks.stopRequested();
        i++
      )
        await sleep(launchProbeMs);
      continue;
    }

    // Bounded window for the child to bring CDP up.
    let healthy = false;
    for (let i = 0; i < launchProbes; i++) {
      if (child.exitCode !== null) break; // died before CDP came up
      if (await cdpProbe(CDP_BASE)) {
        healthy = true;
        break;
      }
      await sleep(launchProbeMs);
    }
    if (!healthy) {
      healthy = Boolean(await cdpProbe(CDP_BASE));
    }
    if (!healthy) {
      lastError = "CDP never became reachable";
      log("launch failed:", lastError);
      status("failed", child.pid);
      try {
        child.kill();
      } catch {
        /* gone */
      }
      const delay = Math.min(
        maxBackoffMs,
        launchProbeMs * 2 ** Math.min(relaunchCount, 5),
      );
      relaunchCount++;
      for (
        let i = 0;
        i < Math.ceil(delay / launchProbeMs) && !hooks.stopRequested();
        i++
      )
        await sleep(launchProbeMs);
      continue;
    }

    lastError = null;
    relaunchCount = 0;
    status("up", child.pid);
    log(`chromium healthy, CDP reachable (pid=${child.pid})`);

    // ---- supervision loop: heartbeat-probe until death/stop ----
    while (!hooks.stopRequested()) {
      await sleep(heartbeatMs);
      if (hooks.stopRequested()) break;
      const alive = await cdpProbe(CDP_BASE);
      if (alive) {
        lastError = null;
        continue;
      }
      lastError = "CDP unresponsive, recycling browser";
      log("CDP unresponsive, recycling");
      try {
        child.kill();
      } catch {
        /* gone */
      }
      await sleep(recycleGraceMs);
      relaunchCount++;
      status("relaunching", child.pid);
      break; // break inner loop -> outer spawn loop respawns
    }
  }

  status("stopping", null);
  log("supervisor stopped");
  hooks.onStopped?.();
}

/** Word of truth for the CDP endpoint the keeper exposes. */
export { CDP_BASE, CDP_PORT, PROFILE_DIR, LAUNCH_PROBE_MS, HEARTBEAT_MS };
