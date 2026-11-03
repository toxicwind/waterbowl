// config.ts — shared constants + config resolution for the cuprite.
//
// Pure constants only; executable resolution and chromium spawning live in
// browser.ts. Keeping this file free of filesystem calls makes it trivially
// testable and safe to import from the MCP server (src/index.ts).

/**
 * Resolve the CDP debugging port. Exported call-time so tests can exercise
 * the env override without a fresh process; the const below snapshots it.
 */
export function readCdpPort(): number {
  return Number(process.env.CUPRITE_CDP_PORT ?? 25234);
}

/** Resolve the chromium profile dir. See readCdpPort for the rationale. */
export function readProfileDir(): string {
  return (
    process.env.KEEPER_PROFILE_DIR ??
    "/home/toxic/.browserless/profiles/nv-audit"
  );
}

export const CDP_PORT = readCdpPort();
export const PROFILE_DIR = readProfileDir();
export const KEEPER_DIR = "/home/toxic/.browserless/cuprite";
export const STATUS_FILE = `${KEEPER_DIR}/status.json`;
export const DEFAULT_DISPLAY = ":99";

export function jestResetEnv() {
  if (process.env.WAYLAND_DISPLAY !== undefined)
    delete process.env.WAYLAND_DISPLAY;
  // The keeper is DEFINED to run on the Xvnc :99 desktop. It must NOT inherit
  // the caller's display: pitchfork/agents often hold DISPLAY=:0, and `??=`
  // would preserve that wrong value (so the keeper chromium + anything it
  // launches end up on :0, not the keeper's Xvnc). Force it to :99.
  process.env.DISPLAY = ":99";
  process.env.XDG_RUNTIME_DIR ??= "/run/user/1000";
}

export const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
export const CDP_VERSION_URL = `${CDP_BASE}/json/version`;

export const CHROMIUM_ARGS = [
  `--remote-debugging-port=${CDP_PORT}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--ozone-platform=x11",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-position=0,0",
  "--window-size=1600,900",
  `--user-data-dir=${PROFILE_DIR}`,
];
