#!/usr/bin/env bun
/**
 * thresher-smoke.ts — keeper exercise suite THROUGH the Thresher connector.
 *
 * Tansy 2026-10-19 (T3), DP3 refresh 2026-10-26. Lanes consume the keeper via
 * Thresher (mcpproxy daemon :25127 -> browserless MCP -> keeper CDP :25233),
 * not via raw CDP — so this suite drives that exact path end-to-end:
 * status, tabs, new_tab, fill, click, evaluate, text, screenshot, close_tab.
 *
 * Interface (current mcpproxy): intent-based calls.
 *   thresher --config CFG call tool-read  --tool-name=browserless:TOOL --json_args='{}'
 *   thresher --config CFG call tool-write --tool-name=browserless:TOOL --json_args='{}'
 * Read-only tools go through tool-read; mutating tools (new_tab, fill, click,
 * evaluate, close_tab) go through tool-write.
 *
 * The test page is a data: URL (no network dependency): an input, a button
 * that copies the input into an output div, and a known title.
 *
 * Usage:  bun smoke/thresher-smoke.ts
 * Env:    THRESHER=/path/to/thresher (default pens/ranch/thresher/bin/thresher)
 *         THRESHER_CONFIG=/path/to/mcp_config.json (default estate/ranch/thresher)
 * Exit:   0 = all steps pass, 1 = first failure (with the tool output shown).
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const THRESHER =
  process.env.THRESHER || join(homedir(), "pens/ranch/thresher/bin/thresher");
const THRESHER_CONFIG =
  process.env.THRESHER_CONFIG ||
  join(homedir(), "estate/ranch/thresher/mcp_config.json");
const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<title>TansySmoke</title>` +
      `<input id="in">` +
      `<button id="btn" onclick="document.getElementById('out').textContent=document.getElementById('in').value">Go</button>` +
      `<div id="out"></div>`,
  );

const READ_TOOLS = new Set([
  "persistent_status",
  "persistent_tabs",
  "persistent_text",
  "persistent_screenshot",
]);

let step = 0;
function call(tool: string, args: unknown): string {
  const variant = READ_TOOLS.has(tool) ? "tool-read" : "tool-write";
  const r = spawnSync(
    THRESHER,
    [
      "--config",
      THRESHER_CONFIG,
      "call",
      variant,
      "--tool-name",
      `browserless:${tool}`,
      "--json_args",
      JSON.stringify(args ?? {}),
      "--timeout",
      "55s",
      "-o",
      "json",
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const all = stdout + stderr;
  if (r.status !== 0) {
    throw new Error(`${tool} exited ${r.status}: ${all.slice(0, 400)}`);
  }
  if (stdout.includes('"isError": true') || stdout.includes('"isError":true')) {
    throw new Error(`${tool} returned a tool error: ${all.slice(0, 400)}`);
  }
  // stdout only: stderr carries mcpproxy's progress banner, which would break
  // envelope detection in unwrapJson.
  return stdout;
}
function check(name: string, ok: boolean, detail = "") {
  step++;
  if (!ok) {
    console.error(`FAIL ${step}. ${name} ${detail}`);
    process.exit(1);
  }
  console.log(`PASS ${step}. ${name}`);
}
function extractBalanced(
  text: string,
  open: string,
  close: string,
): string | undefined {
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function unwrapJson<T>(raw: string): T {
  // mcpproxy -o json envelope: {content:[{text:"...",type:"text"}],isError}
  // The tool payload rides inside content[0].text wrapped by Thresher's
  // untrusted-spotlight markers:
  // "[map[text:«untrusted:...»\n{JSON}\n«/untrusted:...» type:text]]"
  let text = raw;
  try {
    const env = JSON.parse(raw) as {
      content?: Array<{ text?: string; type?: string }>;
      isError?: boolean;
    };
    if (env?.content?.[0]?.text) text = env.content[0].text;
  } catch {
    // raw was not an envelope — fall through with the raw text
  }
  text = text.replace(/«[^»]*»/g, ""); // strip spotlight markers
  // The Go render wraps payloads as "[map[text:{JSON-or-ARRAY} type:text]]".
  // Balanced slices of the wrapper text are not JSON, so scan every balanced
  // candidate (each "{" / "[" position, in order) and return the first that
  // actually parses. This handles both object and array payloads without
  // mistaking a single tab object for the whole tab list.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const close = ch === "{" ? "}" : "]";
    const parsed = safeParse<T>(extractBalanced(text.slice(i), ch, close));
    if (parsed !== undefined) return parsed;
  }
  throw new Error(`no JSON payload in: ${text.slice(0, 200)}`);
}

function safeParse<T>(s: string | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

// 1. status
const status = unwrapJson<{ cdpAlive: boolean }>(call("persistent_status", {}));
check("persistent_status cdpAlive", status.cdpAlive === true);

// 2. baseline tabs
const tabsBefore = unwrapJson<unknown[]>(call("persistent_tabs", {}));
check(
  "persistent_tabs baseline",
  Array.isArray(tabsBefore),
  `count=${tabsBefore.length}`,
);

// 3. new tab with the test page
const opened = call("persistent_new_tab", { url: PAGE });
check(
  "persistent_new_tab TansySmoke",
  opened.includes("TansySmoke"),
  opened.slice(0, 120),
);
const tabsMid = unwrapJson<unknown[]>(call("persistent_tabs", {}));
check("tab count +1", tabsMid.length === tabsBefore.length + 1);

// 4-6. fill -> click -> evaluate round-trip
call("persistent_fill", { selector: "#in", text: "tansy-was-here" });
check("persistent_fill #in", true);
call("persistent_click", { selector: "#btn" });
check("persistent_click #btn", true);
const outVal = call("persistent_evaluate", {
  js: "document.getElementById('out').textContent",
});
check(
  "persistent_evaluate round-trip",
  outVal.includes("tansy-was-here"),
  outVal.slice(0, 120),
);

// 7. visible text
const text = call("persistent_text", {});
check("persistent_text has button", text.includes("Go"), text.slice(0, 120));

// 8. screenshot returns its marker (image payload rides as an attachment)
const shot = call("persistent_screenshot", {});
check(
  "persistent_screenshot marker",
  shot.includes("Screenshot"),
  shot.slice(0, 120),
);

// 9. close our tab (last index) and confirm baseline restored
const idx = tabsMid.length - 1;
call("persistent_close_tab", { tab: idx });
const tabsAfter = unwrapJson<unknown[]>(call("persistent_tabs", {}));
check(
  "persistent_close_tab restores baseline",
  tabsAfter.length === tabsBefore.length,
);

console.log(`thresher-smoke: ALL ${step} PASS`);
