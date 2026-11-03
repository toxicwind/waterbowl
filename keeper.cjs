// browser-keeper: one persistent headed Chromium for the whole mesh.
//
// Owns PROFILE_DIR exclusively. Exposes CDP on 127.0.0.1:9223 for MCP tasks
// (browserless-mcp persistent_* tools), one-shot scripts via
// chromium.connectOverCDP, and debugging. Relaunches itself when Chromium
// dies. Pitchfork supervises the keeper process itself.
//
// Status: /home/toxic/.browserless/keeper/status.json
const { chromium } = require("/home/toxic/.browserless/app/node_modules/playwright-core");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execSync } = require("child_process");

const PROFILE_DIR = "/home/toxic/.browserless/profiles/nv-audit";
// CDP port must come from the estate Port SSOT (config/ports.env -> 25xxx),
// not a hardcoded 9223. pitchfork injects env_file; dev/fallback = 25154.
const CDP_PORT = Number(process.env.BROWSER_KEEPER_CDP_PORT) || 25154;
const KEEPER_DIR = "/home/toxic/.browserless/keeper";
const STATUS_FILE = path.join(KEEPER_DIR, "status.json");

const log = (...args) => console.log(new Date().toISOString(), "[keeper]", ...args);
let activeCtx = null;

// Production tracking: uptime anchor, relaunch history, last failure.
const STARTED_AT = new Date().toISOString();
let relaunchCount = 0;
let lastError = null;
let lastHealthyAt = Date.now();

// Sable 2026-09-30: hard-recycle helpers. A wedged chromium (ptrace-stopped
// crashpad, flock deadlock, ...) does not die on ctx.close() -- the 2026-09-30
// incident piled 100+ chrome/crashpad processes behind one wedged crashpad's
// flock on the shared Crash Reports settings.dat, taking down the keeper AND
// the browserless pool. So: find keeper chromes by PROFILE_DIR in their
// cmdline, and SIGKILL them when graceful close fails or stale ones linger.
function keeperChromePids() {
  try {
    const out = execSync("ps -eo pid,args", { encoding: "utf8" });
    const pids = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid) continue;
      const cmd = m[2];
      if (cmd.includes("/chrome-linux64/chrome") && cmd.includes(PROFILE_DIR)) pids.push(pid);
    }
    return pids;
  } catch (e) { log("pid scan failed:", e.message); return []; }
}

function sigkillPids(pids, why) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); log("SIGKILL pid " + pid + " (" + why + ")"); }
    catch (e) { /* already gone */ }
  }
}

async function hardRecycle(ctx, why) {
  log("hard recycle:", why);
  try {
    await Promise.race([
      (async () => { try { await ctx.close(); } catch (e) { log("close error:", e.message); } })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("close-timeout")), 10000)),
    ]);
  } catch (e) { log("graceful close failed/timed out:", e.message); }
  await new Promise((r) => setTimeout(r, 2000));
  const lingering = keeperChromePids();
  if (lingering.length) sigkillPids(lingering, "recycle-linger");
  else log("graceful close reaped all keeper chromes");
  activeCtx = null;
}

async function shutdown(signal) {
  log(signal + " received, closing browser");
  try { if (activeCtx) await activeCtx.close(); } catch (e) { log("close error:", e.message); }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function cdpAlive() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: CDP_PORT, path: "/json/version", timeout: 3000 },
      (res) => resolve(res.statusCode === 200)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function baseStatus(state) {
  return {
    cdp: "http://127.0.0.1:" + CDP_PORT,
    pid: process.pid,
    state,
    profile: PROFILE_DIR,
    started_at: STARTED_AT,
    relaunch_count: relaunchCount,
    last_error: lastError,
  };
}

function writeStatus(state) {
  try {
    fs.mkdirSync(KEEPER_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(Object.assign({}, state, { at: new Date().toISOString() })));
  } catch (e) { log("status write failed:", e.message); }
}

async function launchOnce() {
  log("launching persistent headed chromium on profile " + PROFILE_DIR);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      "--remote-debugging-port=" + CDP_PORT,
      "--disable-blink-features=AutomationControlled",
      "--ozone-platform=x11",  // Forge 2026-09-21: force X11 on :99 (hint was ignored)
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=0,0",
      "--window-size=1600,900",
      "--start-maximized",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1600, height: 900 },
    locale: "en-US",
  });
  activeCtx = ctx;

  // Window bounds enforcer: keep outer window holder within 1600x900 resolution
  try {
    const { execSync } = require("child_process");
    execSync("xdotool search --onlyvisible --class chromium windowsize 1600 900 windowmove 0 0", {
      env: Object.assign({}, process.env, { DISPLAY: ":99" }),
      timeout: 3000,
    });
  } catch (_) {}
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  writeStatus(baseStatus("up"));
  log("chromium up, CDP on 127.0.0.1:" + CDP_PORT);

  // Auto-restore cookies from Secretsmith Cookie-Vault on startup so sessions never vanish
  const backupCookieFile = "/home/toxic/.browserless/cookies-backup.json";
  try {
    // Full-session sync (cookies + per-origin localStorage) from live Firefox
    // into the keeper Chromium. 2026-10-20: the prior `secretsmith cookie-vault
    // sync` was a dead stub (no such subcommand; exited 1 in try/catch, so
    // sessions never restored). Use the real ranch/cookie-vault CLI instead.
    try {
      const { execSync } = require("child_process");
      execSync(
        "bun /home/toxic/estate/ranch/cookie-vault/bin/cookie-vault.js sync",
        { timeout: 20000, env: Object.assign({}, process.env, { DISPLAY: ":99" }) },
      );
      log("cookie-vault: synced full Firefox session (cookies + localStorage) into keeper");
    } catch (_) {}

    if (fs.existsSync(backupCookieFile)) {
      const rawBackup = JSON.parse(fs.readFileSync(backupCookieFile, "utf8"));
      if (Array.isArray(rawBackup) && rawBackup.length > 0) {
        await ctx.addCookies(rawBackup);
        log("restored " + rawBackup.length + " session cookies from vault on launch");
      }
    }
  } catch (ce) {
    log("cookie restore failed on startup:", ce.message);
  }

  let checks = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    checks++;
    if (!(await cdpAlive())) { log("CDP unresponsive, recycling browser"); break; }
    lastHealthyAt = Date.now();

    // Auto-save cookies every 60 seconds so new logins and tokens are perpetually saved
    if (checks % 6 === 0) {
      try {
        const liveCookies = await ctx.cookies();
        if (liveCookies && liveCookies.length > 0) {
          fs.writeFileSync(backupCookieFile, JSON.stringify(liveCookies, null, 2));
        }
      } catch (se) {
        /* non-fatal background cookie backup */
      }
    }

    // Bounded observability: one heartbeat per ~5min instead of silence.
    if (checks % 30 === 0) {
      log("heartbeat: chromium healthy", {
        checks,
        uptimeMin: Math.round((Date.now() - Date.parse(STARTED_AT)) / 60000),
      });
    }
  }
  await hardRecycle(ctx, "CDP unresponsive");
  writeStatus(baseStatus("relaunching"));
}

(async () => {
  if (await cdpAlive()) {
    log("CDP already alive on :" + CDP_PORT + " - another keeper owns it, exiting");
    process.exit(0);
  }
  for (;;) {
    const stale = keeperChromePids();
    if (stale.length) {
      log("stale keeper chromes from a previous incident, reaping:", stale.join(","));
      sigkillPids(stale, "startup-stale-reap");
      await new Promise((r) => setTimeout(r, 2000));
    }
    try { await launchOnce(); }
    catch (e) {
      lastError = e && e.message ? e.message : String(e);
      log("launch failed:", lastError);
    }
    // Backoff with jitter; a sustained healthy run (>2min) resets the
    // count so one old crash doesn't permanently slow recovery.
    const n = (Date.now() - lastHealthyAt > 120000) ? 0 : relaunchCount;
    const delayMs = Math.min(120000, 5000 * 2 ** n) + Math.floor(Math.random() * 1500);
    relaunchCount = n + 1;
    log("relaunching", { inMs: delayMs, relaunchCount, lastError });
    writeStatus(baseStatus("relaunching"));
    await new Promise((r) => setTimeout(r, delayMs));
  }
})();
