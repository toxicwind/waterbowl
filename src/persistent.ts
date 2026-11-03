// Production-grade client for the browser-keeper persistent Chromium.
//
// The keeper (projects/range/ranch/barn/browserless/keeper) owns ONE headed Chromium on
// the nv-audit profile and exposes CDP on 127.0.0.1:9223. These tools attach
// to THAT browser via chromium.connectOverCDP instead of spawning ephemeral
// sessions, so logins, tabs and state survive across tasks. No
// initialize_browserless needed: the keeper is independent of the
// Browserless HTTP service (:25130, a separate vendor app).
//
// Design notes:
// - Every public method validates args with zod and throws KeeperError with
//   a machine-readable code plus a human message. Nothing is swallowed.
// - The CDP handle is cached; staleness is detected via a version() probe
//   AND the 'disconnected' event. Reconnect uses backoff with jitter.
// - Every Playwright call has a timeout. Tab operations default to the
//   last-active tab and never touch another tab implicitly.
// - Logging goes to stderr as JSON lines (stdout is the MCP wire).
import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import { z } from "zod";

export const KEEPER_CDP = process.env.BROWSER_KEEPER_CDP || "http://127.0.0.1:9223";
export const KEEPER_STATUS_FILE =
  process.env.BROWSER_KEEPER_STATUS || "/home/toxic/.browserless/keeper/status.json";

function numEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const NAV_TIMEOUT_MS = numEnv("BROWSER_KEEPER_NAV_TIMEOUT", 60000);
const OP_TIMEOUT_MS = numEnv("BROWSER_KEEPER_OP_TIMEOUT", 15000);
const EVAL_TIMEOUT_MS = numEnv("BROWSER_KEEPER_EVAL_TIMEOUT", 30000);
const CONNECT_TIMEOUT_MS = numEnv("BROWSER_KEEPER_CONNECT_TIMEOUT", 15000);
const CONNECT_RETRIES = numEnv("BROWSER_KEEPER_CONNECT_RETRIES", 3);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type KeeperErrorCode =
  | "KEEPER_DOWN"
  | "CDP_CONNECT_FAILED"
  | "TAB_NOT_FOUND"
  | "TAB_LAST_TAB"
  | "INVALID_ARGS"
  | "NAV_TIMEOUT"
  | "SELECTOR_TIMEOUT"
  | "OP_TIMEOUT"
  | "EVAL_FAILED"
  | "SCREENSHOT_FAILED";

export class KeeperError extends Error {
  readonly code: KeeperErrorCode;
  readonly cause?: unknown;
  constructor(code: KeeperErrorCode, message: string, cause?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "KeeperError";
    this.code = code;
    this.cause = cause;
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Structured logging (stderr — stdout is the MCP wire)
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const ACTIVE_LEVEL: LogLevel = (() => {
  const v = (process.env.BROWSER_MCP_LOG_LEVEL || "info").toLowerCase();
  return (LOG_LEVELS[v as LogLevel] !== undefined ? v : "info") as LogLevel;
})();

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[ACTIVE_LEVEL]) return;
  try {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level, component: "persistent", msg, ...fields }) + "\n"
    );
  } catch {
    // logging must never break the caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new KeeperError("OP_TIMEOUT", `${op} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeoutLike(e: unknown): boolean {
  if (e instanceof KeeperError && e.code === "OP_TIMEOUT") return true;
  return /timeout|timed out|exceeded/i.test(errMsg(e));
}

// ---------------------------------------------------------------------------
// Arg validation (zod — every public method validates first)
// ---------------------------------------------------------------------------

const UrlSchema = z
  .string({ required_error: "url is required", invalid_type_error: "url must be a string" })
  .refine(
    (s) => {
      try {
        const u = new URL(s);
        return ["http:", "https:", "data:"].includes(u.protocol);
      } catch {
        return false;
      }
    },
    { message: "url must be a valid http(s) or data: URL" }
  );

const SelectorSchema = z
  .string({ required_error: "selector is required", invalid_type_error: "selector must be a string" })
  .min(1, "selector must not be empty")
  .max(2000, "selector is unreasonably long");

const JsSchema = z
  .string({ required_error: "js is required", invalid_type_error: "js must be a string" })
  .min(1, "js must not be empty")
  .max(100000, "js payload exceeds 100KB");

const TextSchema = z
  .string({ required_error: "text is required", invalid_type_error: "text must be a string" })
  .max(100000, "text payload exceeds 100KB");

const TabIndexSchema = z
  .number({ invalid_type_error: "tab must be a number" })
  .int("tab must be an integer")
  .min(0, "tab must be >= 0");

const OptTabSchema = TabIndexSchema.optional();

function invalidArgs(e: unknown, what: string): KeeperError {
  return new KeeperError("INVALID_ARGS", `${what}: ${errMsg(e)}`, e);
}

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export class PersistentBrowser {
  private browser: Browser | null = null;
  private activeTab = 0;

  // -- connection -----------------------------------------------------------

  /** Cheap liveness check: version() is sync (Playwright >= 1.49); the title()
   *  call is a real CDP round-trip and throws if the session is dead. */
  private async checkAlive(b: Browser): Promise<void> {
    b.version();
    const page = b.contexts()[0]?.pages()[0];
    if (page) await page.title();
  }

  private async connect(): Promise<Browser> {
    if (this.browser) {
      try {
        await withTimeout(this.checkAlive(this.browser), 5000, "keeper liveness probe");
        return this.browser;
      } catch (e) {
        log("warn", "cached keeper handle stale, reconnecting", { error: errMsg(e) });
        this.browser = null;
      }
    }
    const maxAttempts = Math.max(0, Math.floor(CONNECT_RETRIES));
    let last: unknown = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        const b = await withTimeout(
          chromium.connectOverCDP(KEEPER_CDP),
          CONNECT_TIMEOUT_MS,
          `connectOverCDP(${KEEPER_CDP})`
        );
        b.on("disconnected", () => {
          if (this.browser === b) {
            log("warn", "keeper CDP disconnected, dropping cached handle");
            this.browser = null;
          }
        });
        this.browser = b;
        log("info", "attached to keeper via CDP", { cdp: KEEPER_CDP, attempt: attempt + 1 });
        return b;
      } catch (e) {
        last = e;
        if (attempt < maxAttempts) {
          const backoff = Math.round(250 * 2 ** attempt + Math.random() * 250);
          log("warn", "CDP attach failed, backing off", {
            attempt: attempt + 1,
            backoffMs: backoff,
            error: errMsg(e),
          });
          await sleep(backoff);
        }
      }
    }
    throw new KeeperError(
      "CDP_CONNECT_FAILED",
      `cannot attach to keeper CDP at ${KEEPER_CDP} after ${maxAttempts + 1} attempt(s). ` +
        `Is keeper.js running? (pitchfork start browser-keeper)`,
      last
    );
  }

  /** Close our CDP session (Chromium keeps running — the keeper owns it). */
  async disconnect(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) {
      try {
        await b.close();
        log("info", "keeper CDP session closed");
      } catch (e) {
        log("warn", "keeper CDP session close failed", { error: errMsg(e) });
      }
    }
  }

  private async context(): Promise<BrowserContext> {
    const b = await this.connect();
    const ctxs = b.contexts();
    if (ctxs.length === 0) {
      throw new KeeperError(
        "KEEPER_DOWN",
        "keeper browser has no contexts — Chromium is probably mid-relaunch; retry shortly"
      );
    }
    return ctxs[0];
  }

  private async resolve(tab?: number): Promise<{ page: Page; index: number }> {
    let idx: number;
    try {
      idx = OptTabSchema.parse(tab) ?? this.activeTab;
    } catch (e) {
      throw invalidArgs(e, "tab");
    }
    const ctx = await this.context();
    const pages = ctx.pages();
    if (pages.length === 0) {
      const p = await withTimeout(ctx.newPage(), OP_TIMEOUT_MS, "newPage (keeper had no pages)");
      this.activeTab = 0;
      log("info", "keeper had no pages, created one", { tab: 0 });
      return { page: p, index: 0 };
    }
    if (idx < 0 || idx >= pages.length) {
      if (tab !== undefined) {
        throw new KeeperError(
          "TAB_NOT_FOUND",
          `tab ${tab} does not exist — ${pages.length} tab(s) open (see persistent_tabs)`
        );
      }
      idx = 0;
    }
    this.activeTab = idx;
    return { page: pages[idx], index: idx };
  }

  // -- tab management ---------------------------------------------------------

  async tabs(): Promise<TabInfo[]> {
    const ctx = await this.context();
    const pages = ctx.pages();
    const infos: TabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      let url = "";
      let title = "";
      try {
        url = pages[i].url();
      } catch {
        // page going away; report what we can
      }
      try {
        title = await withTimeout(pages[i].title(), 5000, `title(tab ${i})`);
      } catch (e) {
        log("debug", "title probe failed", { tab: i, error: errMsg(e) });
      }
      infos.push({ index: i, url, title, active: i === this.activeTab });
    }
    return infos;
  }

  async newTab(url?: string): Promise<TabInfo> {
    if (url !== undefined) {
      try {
        UrlSchema.parse(url);
      } catch (e) {
        throw invalidArgs(e, "url");
      }
    }
    const ctx = await this.context();
    const pages = ctx.pages();
    const p = await withTimeout(ctx.newPage(), OP_TIMEOUT_MS, "newPage").catch((e) => {
      throw new KeeperError("OP_TIMEOUT", `new_tab failed: ${errMsg(e)}`, e);
    });
    const index = pages.length; // new page appends at the end
    this.activeTab = index;
    log("info", "new tab opened", { tab: index, url: url ?? "(blank)" });
    if (url) {
      await this.navigate(url, { tab: index });
    } else {
      await withTimeout(p.bringToFront(), OP_TIMEOUT_MS, `bringToFront(tab ${index})`).catch(() => {});
    }
    const infos = await this.tabs();
    const info = infos.find((t) => t.index === index);
    if (!info) throw new KeeperError("KEEPER_DOWN", `new tab ${index} vanished immediately after creation`);
    return info;
  }

  async closeTab(tab: number): Promise<{ closed: number; remaining: number }> {
    let idx: number;
    try {
      idx = TabIndexSchema.parse(tab);
    } catch (e) {
      throw invalidArgs(e, "tab");
    }
    const ctx = await this.context();
    const pages = ctx.pages();
    if (idx >= pages.length) {
      throw new KeeperError(
        "TAB_NOT_FOUND",
        `tab ${idx} does not exist — ${pages.length} tab(s) open (see persistent_tabs)`
      );
    }
    if (pages.length === 1) {
      throw new KeeperError(
        "TAB_LAST_TAB",
        "refusing to close the keeper's last tab — open a new tab first (persistent_new_tab)"
      );
    }
    try {
      await withTimeout(pages[idx].close(), OP_TIMEOUT_MS, `close(tab ${idx})`);
    } catch (e) {
      throw new KeeperError("OP_TIMEOUT", `close(tab ${idx}) failed: ${errMsg(e)}`, e);
    }
    const remaining = pages.length - 1;
    // Tabs after the closed one shift down by one; keep activeTab pointing at
    // the same logical tab it pointed at before the close.
    if (this.activeTab > idx) this.activeTab -= 1;
    this.activeTab = Math.min(Math.max(0, this.activeTab), remaining - 1);
    log("info", "tab closed", { tab: idx, remaining });
    return { closed: idx, remaining };
  }

  async activateTab(tab: number): Promise<TabInfo> {
    const { page: p, index } = await this.resolve(tab);
    try {
      await withTimeout(p.bringToFront(), OP_TIMEOUT_MS, `bringToFront(tab ${index})`);
    } catch (e) {
      throw new KeeperError("OP_TIMEOUT", `activate(tab ${index}) failed: ${errMsg(e)}`, e);
    }
    this.activeTab = index;
    log("info", "tab activated", { tab: index });
    const infos = await this.tabs();
    return infos[index];
  }

  // -- page operations ----------------------------------------------------------

  async status(): Promise<Record<string, unknown>> {
    let keeperFile: Record<string, unknown> = {};
    let fileError: string | null = null;
    try {
      keeperFile = JSON.parse(fs.readFileSync(KEEPER_STATUS_FILE, "utf8"));
    } catch (e) {
      fileError = `status file unreadable (${KEEPER_STATUS_FILE}): ${errMsg(e)}`;
    }
    let cdpAlive = false;
    let cdpError: string | null = null;
    let browserName: string | null = null;
    try {
      const res = await withTimeout(fetch(KEEPER_CDP + "/json/version"), 5000, "keeper /json/version probe");
      cdpAlive = res.ok;
      if (res.ok) {
        const v = (await res.json()) as { Browser?: string };
        browserName = v?.Browser ?? null;
      } else {
        cdpError = `HTTP ${res.status}`;
      }
    } catch (e) {
      cdpError = errMsg(e);
    }
    return {
      keeper: keeperFile,
      fileError,
      cdpAlive,
      cdpError,
      browser: browserName,
      cdpUrl: KEEPER_CDP,
      checkedAt: new Date().toISOString(),
    };
  }

  async navigate(
    url: string,
    opts: { tab?: number; timeoutMs?: number } = {}
  ): Promise<{ url: string; title: string; tab: number }> {
    let u: string;
    try {
      u = UrlSchema.parse(url);
    } catch (e) {
      throw invalidArgs(e, "url");
    }
    const timeout = opts.timeoutMs ?? NAV_TIMEOUT_MS;
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      await withTimeout(p.goto(u, { waitUntil: "domcontentloaded", timeout }), timeout, `navigate(tab ${index}) -> ${u}`);
    } catch (e) {
      throw new KeeperError(
        isTimeoutLike(e) ? "NAV_TIMEOUT" : "OP_TIMEOUT",
        `navigate(tab ${index}) to ${u} failed: ${errMsg(e)}`,
        e
      );
    }
    let title = "";
    try {
      title = await withTimeout(p.title(), 5000, `title(tab ${index})`);
    } catch (e) {
      log("debug", "title probe failed after navigate", { tab: index, error: errMsg(e) });
    }
    log("info", "navigated", { tab: index, url: p.url(), title });
    return { url: p.url(), title, tab: index };
  }

  async screenshot(opts: { fullPage?: boolean; tab?: number } = {}): Promise<string> {
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      const buf = await withTimeout(
        p.screenshot({ fullPage: opts.fullPage ?? false, timeout: OP_TIMEOUT_MS }),
        OP_TIMEOUT_MS + 5000,
        `screenshot(tab ${index})`
      );
      log("info", "screenshot taken", { tab: index, bytes: buf.length, fullPage: opts.fullPage ?? false });
      return buf.toString("base64");
    } catch (e) {
      throw new KeeperError("SCREENSHOT_FAILED", `screenshot(tab ${index}) failed: ${errMsg(e)}`, e);
    }
  }

  async click(selector: string, opts: { tab?: number } = {}): Promise<{ ok: boolean; selector: string; tab: number }> {
    let sel: string;
    try {
      sel = SelectorSchema.parse(selector);
    } catch (e) {
      throw invalidArgs(e, "selector");
    }
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      await withTimeout(p.click(sel, { timeout: OP_TIMEOUT_MS }), OP_TIMEOUT_MS, `click(tab ${index}, ${sel})`);
    } catch (e) {
      throw new KeeperError(
        isTimeoutLike(e) ? "SELECTOR_TIMEOUT" : "OP_TIMEOUT",
        `click(tab ${index}, selector ${JSON.stringify(sel)}) failed: ${errMsg(e)}`,
        e
      );
    }
    log("info", "clicked", { tab: index, selector: sel });
    return { ok: true, selector: sel, tab: index };
  }

  async fill(
    selector: string,
    text: string,
    opts: { tab?: number } = {}
  ): Promise<{ ok: boolean; selector: string; tab: number }> {
    let sel: string;
    let t: string;
    try {
      sel = SelectorSchema.parse(selector);
      t = TextSchema.parse(text);
    } catch (e) {
      throw invalidArgs(e, "selector/text");
    }
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      await withTimeout(p.fill(sel, t, { timeout: OP_TIMEOUT_MS }), OP_TIMEOUT_MS, `fill(tab ${index}, ${sel})`);
    } catch (e) {
      throw new KeeperError(
        isTimeoutLike(e) ? "SELECTOR_TIMEOUT" : "OP_TIMEOUT",
        `fill(tab ${index}, selector ${JSON.stringify(sel)}) failed: ${errMsg(e)}`,
        e
      );
    }
    log("info", "filled", { tab: index, selector: sel, chars: t.length });
    return { ok: true, selector: sel, tab: index };
  }

  async pageText(opts: { tab?: number } = {}): Promise<string> {
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      return await withTimeout(
        p.evaluate(() => (document.body ? document.body.innerText : "")),
        EVAL_TIMEOUT_MS,
        `pageText(tab ${index})`
      );
    } catch (e) {
      throw new KeeperError("EVAL_FAILED", `pageText(tab ${index}) failed: ${errMsg(e)}`, e);
    }
  }

  async evaluate(js: string, opts: { tab?: number } = {}): Promise<unknown> {
    let code: string;
    try {
      code = JsSchema.parse(js);
    } catch (e) {
      throw invalidArgs(e, "js");
    }
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      // Wrap in an async function so both sync values and promises work.
      return await withTimeout(
        p.evaluate(`(async () => { return (${code}); })()`),
        EVAL_TIMEOUT_MS,
        `evaluate(tab ${index})`
      );
    } catch (e) {
      throw new KeeperError("EVAL_FAILED", `evaluate(tab ${index}) failed: ${errMsg(e)}`, e);
    }
  }

  async content(opts: { tab?: number } = {}): Promise<{ html: string; title: string; url: string }> {
    const { page: p, index } = await this.resolve(opts.tab);
    try {
      const html = await withTimeout(p.content(), EVAL_TIMEOUT_MS, `content(tab ${index})`);
      const title = await withTimeout(p.title(), 5000, `title(tab ${index})`).catch(() => "");
      return { html, title, url: p.url() };
    } catch (e) {
      throw new KeeperError("EVAL_FAILED", `content(tab ${index}) failed: ${errMsg(e)}`, e);
    }
  }
}
