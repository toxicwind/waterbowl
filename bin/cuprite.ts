#!/usr/bin/env bun
// bin/cuprite.ts — thin entry for the cuprite daemon.
//
// One persistent headed Chromium on DISPLAY :99 (Xvnc), CDP on 127.0.0.1:<port>.
// All logic lives in src/keeper/{browser,status,supervisor}.ts; this file only
// wires configuration + signal handling and hands off to the supervisor loop.

import {
  spawnChromium,
  resolveChromiumExecutable,
} from "../src/keeper/browser.js";
import { runSupervisor } from "../src/keeper/supervisor.js";
import { cdpAlive as probeCdp, writeStatus } from "../src/keeper/status.js";
import {
  CDP_BASE,
  CDP_PORT,
  CDP_VERSION_URL,
  jestResetEnv,
} from "../src/keeper/config.js";

const log = (...a: unknown[]) =>
  console.log(new Date().toISOString(), "[keeper]", ...a);

// -- environment (wayland off, headed Xvnc :99) --
jestResetEnv();

const cdpAlive = () => probeCdp(CDP_BASE);

// -- chromium binary --
let CHROMIUM: string;
try {
  CHROMIUM = resolveChromiumExecutable();
  log("chromium executable:", CHROMIUM);
} catch (e) {
  log("fatal: could not resolve a chromium binary —", (e as Error).message);
  process.exit(1);
}

let stopRequested = false;
let currentChild: { kill(): void } | null = null;

function shutdown(sig: string) {
  if (stopRequested) return; // already shutting down
  stopRequested = true;
  log(sig + ", closing chromium");
  try {
    currentChild?.kill();
  } catch {
    /* gone */
  }
  writeStatus({
    cdp: CDP_BASE,
    childPid: process.pid,
    state: "stopped",
    startedAt: new Date().toISOString(),
    relaunchCount: 0,
    lastError: null,
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  // If another keeper already owns the port, do not steal it.
  if (await cdpAlive()) {
    log(`CDP already alive on :${CDP_PORT} — another keeper owns it, exiting`);
    writeStatus({
      cdp: CDP_BASE,
      childPid: process.pid,
      state: "waiting",
      startedAt: new Date().toISOString(),
      relaunchCount: 0,
      lastError: `another keeper owns ${CDP_BASE}`,
    });
    process.exit(0);
  }

  await runSupervisor({
    spawn() {
      if (stopRequested) return null;
      const proc = spawnChromium(CHROMIUM);
      currentChild = proc;
      log(
        `spawned chromium pid=${proc.pid} cdp=${CDP_BASE} (version ${CDP_VERSION_URL})`,
      );
      return {
        pid: proc.pid,
        kill: () => proc.kill(),
        get exitCode() {
          return proc.exitCode;
        },
      };
    },
    stopRequested: () => stopRequested,
    onStopped: () => {
      log("shutdown complete");
      process.exit(0);
    },
  });
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
