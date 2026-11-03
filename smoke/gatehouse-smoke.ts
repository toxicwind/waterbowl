#!/usr/bin/env bun
/**
 * gatehouse-smoke.ts — keeper exercise suite THROUGH the Gatehouse connector.
 *
 * Tansy 2026-10-19 (T3). Lanes consume the keeper via Gatehouse
 * (~/workspace/bin/gatehouse -> :25127 -> browserless MCP -> stable/keeper),
 * not via raw CDP — so this suite drives that exact path end-to-end:
 * status, tabs, new_tab, fill, click, evaluate, text, screenshot, close_tab.
 *
 * The test page is a data: URL (no network dependency): an input, a button
 * that copies the input into an output div, and a known title.
 *
 * Usage:  bun gatehouse-smoke.ts
 * Env:    GATEHOUSE=/path/to/gatehouse   (default ~/workspace/bin/gatehouse)
 * Exit:   0 = all steps pass, 1 = first failure (with the tool output shown).
 *
 * Keeper-restart resilience: run it, `pitchfork restart estate/browser-keeper`
 * on yote, run it again — both runs must pass and the tab count must return
 * to baseline each time (the suite cleans up its own tab).
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEHOUSE = process.env.GATEHOUSE || join(homedir(), "workspace/bin/gatehouse");
const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<title>TansySmoke</title>` +
      `<input id="in">` +
      `<button id="btn" onclick="document.getElementById('out').textContent=document.getElementById('in').value">Go</button>` +
      `<div id="out"></div>`
  );

let step = 0;
function call(tool: string, args: unknown): string {
  const r = spawnSync(GATEHOUSE, ["call", `browserless:${tool}`, JSON.stringify(args)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (out.includes('"error"') || out.includes('"error_type"')) {
    throw new Error(`${tool} returned an error: ${out.slice(0, 400)}`);
  }
  return out;
}
function check(name: string, ok: boolean, detail = "") {
  step++;
  if (!ok) {
    console.error(`FAIL ${step}. ${name} ${detail}`);
    process.exit(1);
  }
  console.log(`PASS ${step}. ${name}`);
}
function unwrapJson<T>(raw: string): T {
  const start = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  const s = startArr !== -1 && (start === -1 || startArr < start) ? startArr : start;
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  return JSON.parse(raw.slice(s, end + 1));
}

// 1. status
const status = unwrapJson<{ cdpAlive: boolean }>(call("persistent_status", {}));
check("persistent_status cdpAlive", status.cdpAlive === true);

// 2. baseline tabs
const tabsBefore = unwrapJson<unknown[]>(call("persistent_tabs", {}));
check("persistent_tabs baseline", Array.isArray(tabsBefore), `count=${tabsBefore.length}`);

// 3. new tab with the test page
const opened = call("persistent_new_tab", { url: PAGE });
check("persistent_new_tab TansySmoke", opened.includes("TansySmoke"), opened.slice(0, 120));
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
check("persistent_evaluate round-trip", outVal.includes("tansy-was-here"), outVal.slice(0, 120));

// 7. visible text
const text = call("persistent_text", {});
check("persistent_text has button", text.includes("Go"), text.slice(0, 120));

// 8. screenshot returns its marker (image payload rides as an attachment)
const shot = call("persistent_screenshot", {});
check("persistent_screenshot marker", shot.includes("Screenshot"), shot.slice(0, 120));

// 9. close our tab (last index) and confirm baseline restored
const idx = tabsMid.length - 1;
call("persistent_close_tab", { tab: idx });
const tabsAfter = unwrapJson<unknown[]>(call("persistent_tabs", {}));
check("persistent_close_tab restores baseline", tabsAfter.length === tabsBefore.length);

console.log(`gatehouse-smoke: ALL ${step} PASS`);
