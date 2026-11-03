// browser.ts — chromium spawner + executable resolution for the kennel.
//
// Owns the child chromium process for one persistent headed browser on
// DISPLAY=:99 (Xvnc) with CDP exposed on 127.0.0.1:<port>. Exposes a clean
// spawn/resolve surface so bin/keeper.ts stays a thin entry and the
// supervisor loop (supervisor.ts) can recycle the browser on death.

import { readdirSync, existsSync } from "node:fs";
import { CHROMIUM_ARGS, CDP_PORT, PROFILE_DIR } from "./config.js";

/** Resolve the installed chromium executable, newest revision, overridable. */
export function resolveChromiumExecutable(): string {
  const fromEnv = process.env.KEEPER_CHROMIUM_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/home/toxic/.cache/ms-playwright";
  const hits: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      const bin = `${root}/${entry}/chrome-linux64/chrome`;
      if (existsSync(bin)) hits.push(bin);
    }
  } catch {
    /* no cache */
  }
  hits.sort();
  if (hits.length === 0) throw new Error(`no chromium under ${root}`);
  return hits[hits.length - 1];
}

export type ChromiumProc = Bun.Subprocess<"ignore", "pipe", "pipe">;

/**
 * Spawn the headed kennel chromium. Returns the raw subprocess; the caller
 * (supervisor) owns liveness probing and respawn.
 */
export function spawnChromium(
  executable: string,
  extraArgs: string[] = [],
): ChromiumProc {
  const proc = Bun.spawn(
    [executable, ...CHROMIUM_ARGS, ...extraArgs, "about:blank"],
    {
      env: (() => {
        // Lane pin at SPAWN time (2026-11-03): jestResetEnv runs once at daemon
        // entry, but any spawn after an env mutation (or an entry predating the
        // pin) would launch the browser onto the caller's desktop (:0). The
        // keeper lane is DEFINED as the Xvnc :99 desktop — force it here, per
        // spawn, so relaunches can never drift onto the architect's Wayland
        // session. XDG_RUNTIME_DIR keeps the default when unset.
        const env = { ...process.env };
        delete env.WAYLAND_DISPLAY;
        env.DISPLAY = ":99";
        return env;
      })(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Drain stderr asynchronously so a full pipe never blocks the child. We
  // watch for the "DevTools listening" line to log CDP readiness.
  (async () => {
    try {
      const reader = proc.stderr.getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value, { stream: true });
        // Keep logs flowing line-buffered.
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) console.log(new Date().toISOString(), "[keeper]", line);
          if (line.includes("DevTools listening"))
            console.log(
              new Date().toISOString(),
              "[keeper] CDP up: DevTools listening",
            );
        }
      }
    } catch {
      /* streaming ended */
    }
  })();
  return proc;
}

/**
 * Build the full chromium args for a given binary. Exported for tests and so
 * bin/keeper.ts can log them without re-deriving. The args are the shared
 * CHROMIUM_ARGS from config plus optional extras (e.g. a fresh profile on
 * first launch is handled by the caller).
 */
export function chromiumArgsFor(extraArgs: string[] = []): string[] {
  return [...CHROMIUM_ARGS, ...extraArgs];
}

export { CHROMIUM_ARGS, CDP_PORT, PROFILE_DIR };
