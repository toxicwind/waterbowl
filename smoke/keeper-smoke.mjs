#!/usr/bin/env node
// keeper smoke suite — runs against the LIVE keeper (CDP 127.0.0.1:9223).
//
// Flow: status -> tabs -> new_tab(scratch) -> activate -> navigate ->
// evaluate -> pageText -> screenshot -> error paths -> close_tab -> status.
// Everything happens in a SCRATCH TAB that is closed at the end; the user's
// existing tabs are never navigated, clicked, or filled.
//
// Usage: npm test   (== node smoke/keeper-smoke.mjs)
// Exit 0 = all pass, 1 = any failure. No mocks, no stubs.
import { PersistentBrowser } from "../dist/persistent.js";

const keeper = new PersistentBrowser();
let pass = 0;
let fail = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const MARKER = "keeper-smoke-" + Date.now();
const url1 = `data:text/html,<html><head><title>smoke-one</title></head><body><h1>${MARKER}</h1></body></html>`;
const url2 = `data:text/html,<html><head><title>smoke-two</title></head><body><p>second-${MARKER}</p></body></html>`;

let scratch = -1;
try {
  const s = await keeper.status();
  ok("status: cdpAlive", s.cdpAlive === true, `browser=${s.browser || "?"}`);
  ok("status: no cdpError", !s.cdpError, s.cdpError || "none");

  const before = await keeper.tabs();
  ok("tabs: baseline listed", Array.isArray(before) && before.length >= 1, `${before.length} tab(s)`);

  const nt = await keeper.newTab(url1);
  scratch = nt.index;
  ok("new_tab: index appended", nt.index === before.length, `index=${nt.index}`);
  ok("new_tab: navigated", nt.url.startsWith("data:text/html"), nt.url.slice(0, 24));

  const at = await keeper.activateTab(scratch);
  ok("activate_tab: active", at.active === true && at.index === scratch, `tab=${at.index}`);

  const nav = await keeper.navigate(url2, { tab: scratch });
  ok("navigate: title", nav.title === "smoke-two", JSON.stringify(nav.title));
  ok("navigate: tab echoed", nav.tab === scratch, `tab=${nav.tab}`);

  const title = await keeper.evaluate("document.title", { tab: scratch });
  ok("evaluate: round-trip", title === "smoke-two", JSON.stringify(title));

  const text = await keeper.pageText({ tab: scratch });
  ok("pageText: marker visible", text.includes(`second-${MARKER}`), text.slice(0, 40));

  const shot = await keeper.screenshot({ tab: scratch });
  ok("screenshot: base64 payload", typeof shot === "string" && shot.length > 5000, `${shot.length} chars`);

  // Error paths must fail LOUD with machine-readable codes — never silent.
  let code = "";
  try {
    await keeper.activateTab(9999);
  } catch (e) {
    code = e.code || "";
  }
  ok("error: TAB_NOT_FOUND code", code === "TAB_NOT_FOUND", code || "(no error!)");

  code = "";
  try {
    await keeper.navigate("not a url", { tab: scratch });
  } catch (e) {
    code = e.code || "";
  }
  ok("error: INVALID_ARGS code", code === "INVALID_ARGS", code || "(no error!)");

  code = "";
  try {
    await keeper.click("", { tab: scratch });
  } catch (e) {
    code = e.code || "";
  }
  ok("error: INVALID_ARGS on empty selector", code === "INVALID_ARGS", code || "(no error!)");

  const closed = await keeper.closeTab(scratch);
  scratch = -1;
  ok("close_tab: remaining", closed.remaining === before.length, `${closed.remaining}`);

  const after = await keeper.tabs();
  ok("tabs: back to baseline", after.length === before.length, `${after.length} tab(s)`);

  const s2 = await keeper.status();
  ok("status: keeper still alive", s2.cdpAlive === true, `browser=${s2.browser || "?"}`);
} catch (e) {
  fail++;
  console.error(`FAIL unexpected exception: ${(e && e.message) || e}`);
} finally {
  if (scratch >= 0) {
    try {
      await keeper.closeTab(scratch);
      console.log("cleanup: scratch tab closed");
    } catch (e) {
      console.error("cleanup failed: " + ((e && e.message) || e));
    }
  }
  try {
    await keeper.disconnect();
  } catch {
    // best effort
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
