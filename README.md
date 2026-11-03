# browser-keeper

One persistent headed Chromium for the whole mesh, plus the keeper-first MCP
server that drives it. First-class citizen of the estate: the browser and its
MCP tools live together in this tree.

- **The keeper** — one persistent headed Chromium. Owns
  `/home/toxic/.browserless/profiles/nv-audit` exclusively, exposes CDP on
  `127.0.0.1:9223`, writes `/home/toxic/.browserless/keeper/status.json`,
  relaunches Chromium if it dies. Single-instance: exits if CDP already
  answers.
- **The MCP server** (`src/`, built to `dist/`) — stdio MCP server
  (`browserless-mcp` 1.3.0). Eleven `[keeper-first]` `persistent_*` tools
  attach via `chromium.connectOverCDP` to the keeper — no
  `initialize_browserless` needed, logins/tabs/state survive across tasks.

## What it is

`browser-keeper` is the estate's shared browser: a single long-lived Chromium
that every agent drives through MCP instead of each spawning its own
ephemeral session. The keeper daemon keeps the browser alive; the MCP server
is the control plane. Both live here, built and versioned together.

## Layout

- `keeper.cjs` — the daemon (CommonJS; the `.cjs` extension keeps it working
  under this package's `"type": "module"`). Owns the `nv-audit` profile,
  exposes CDP on `127.0.0.1:9223`, writes the status file, relaunches
  Chromium if it dies.
- `keeper.sh` — pitchfork launcher for the isolated display: unsets
  `WAYLAND_DISPLAY`, sets `DISPLAY=:99`, execs keeper.cjs (Forge 2026-09-21
  — the keeper never renders in the Architect's Hyprland session).
- `pitchfork.fragment.toml` — merge into `[daemons.browser-keeper]` in
  `/home/toxic/pens/estate/pitchfork.toml` (owned sequence from
  `/home/toxic/estate`).
- `browser-toggle.sh` — shows/hides the **VNC viewer** window (the TigerVNC
  client the Architect looks at, which renders the isolated keeper display).
  Not legacy: the keeper's Chromium is on Xvnc :99, but the *viewer* that
  mirrors it is a real Hyprland window, and this toggles it between the
  active workspace and the `special:browser` scratchpad. Dispatch goes through
  `hl.dsp.*` Lua expressions because this Hyprland runs a Lua config (bare
  Hyprland dispatch words are Lua syntax errors here).
- `src/` — the MCP server source (`index.ts`, `persistent.ts`, `client.ts`,
  `types.ts`, `simple-server.ts`).
- `dist/` — `tsc` build output (gitignored; built on the box, never committed).
- `smoke/keeper-smoke.mjs` — smoke suite, runs against the live keeper.
- `../mcp.sh` — stdio launcher: `exec bun keeper/dist/index.js` (repo-relative).

## How it runs

**The keeper daemon** (pitchfork-supervised, `estate/browser-keeper`):

```bash
cd /home/toxic/estate && ./bin/pitchfork-restart estate/browser-keeper --cold
```

Ready when `curl -sf http://127.0.0.1:9223/json/version` answers. It needs the
isolated display (`estate/agent-display`, Xvnc :99) up first — without it the
keeper crash-loops on "Missing X server or $DISPLAY".

**The MCP server** — stdio, no port, no daemon. Build once, launch per client
session:

```bash
cd /home/toxic/pens/estate/ranch/barn/browserless/keeper
npm install && npm run build   # tsc -> dist/ (dist/ and node_modules/ are gitignored)
npm test                       # node smoke/keeper-smoke.mjs against the live keeper
```

`../mcp.sh` execs it on stdio for manual use. In production, Gatehouse spawns
it (see below).

## How it registers in Gatehouse

Gatehouse (`estate/gatehouse`, mcpproxy on `127.0.0.1:25127`) spawns the MCP
server per the `browserless` entry in
`/home/toxic/pens/estate/ranch/barn/gatehouse/mcp_config.json` (live) and
`mcp_config.json.dist` (durable template — the entry must be in BOTH or a
restart drops it):

```json
{
  "name": "browserless",
  "protocol": "stdio",
  "command": "/home/toxic/.local/share/mise/installs/node/22.12.0/bin/node",
  "args": ["/home/toxic/pens/estate/ranch/barn/browserless/keeper/dist/index.js"],
  "enabled": true,
  "health_check_interval": "15s",
  "tool_discovery_interval": "2m0s",
  "isolation": {"enabled": false, "mode": "none"},
  "quarantined": false
}
```

**Quirk (do not regress):** Gatehouse silently drops config entries carrying
an `env` field — the entry must have NO `env` key. The server defaults to
CDP `127.0.0.1:9223`, which is where the keeper listens, so no env is needed.

After changing the entry: `pitchfork-restart estate/gatehouse --cold`
(Gatehouse holds a bolt DB lock; the hot path cannot boot a staging
candidate), then verify with the gatehouse connector:

```bash
~/workspace/bin/gatehouse servers | grep browserless
~/workspace/bin/gatehouse tools persistent_status
~/workspace/bin/gatehouse call browserless:persistent_status '{}'
# expect: cdpAlive true, keeper state up
```

## MCP tools (browserless-mcp 1.3.0, `src/persistent.ts`)

Eleven `[keeper-first]` tools. They attach via `chromium.connectOverCDP`
to the keeper and need no `initialize_browserless`. Every argument is
zod-validated; failures throw `KeeperError` with a machine-readable code
(`TAB_NOT_FOUND`, `TAB_LAST_TAB`, `INVALID_ARGS`, `NAV_TIMEOUT`,
`SELECTOR_TIMEOUT`, `CDP_CONNECT_FAILED`, …) — nothing fails silently.

- `persistent_status` — keeper status file + CDP liveness probe (never throws).
- `persistent_tabs` — list tabs: index, URL, title, which is active.
- `persistent_new_tab [url]` — open a tab (optionally to a URL), make it active.
- `persistent_close_tab <tab>` — close by index; refuses the last tab.
- `persistent_activate_tab <tab>` — bring a tab to front.
- `persistent_navigate <url> [tab]` — per-op timeout (default 60s).
- `persistent_screenshot [fullPage] [tab]`
- `persistent_click <selector> [tab]`
- `persistent_fill <selector> <text> [tab]`
- `persistent_text [tab]`
- `persistent_evaluate <js> [tab]`

Tab ops default to the last-active tab and never touch another tab
implicitly. CDP disconnects are detected (version probe + `disconnected`
event) and reconnected with backoff + jitter. The MCP server refuses to
start when the keeper is down (fail loud; `BROWSER_MCP_ALLOW_NO_KEEPER=1`
bypasses for maintenance) and shuts down gracefully on SIGTERM/SIGINT.

## Keeper status.json

`/home/toxic/.browserless/keeper/status.json` carries: `cdp`, `pid`,
`state` (`up`/`relaunching`), `profile`, `started_at`, `relaunch_count`,
`last_error`, `at`. Relaunches back off with jitter (5s → 120s cap); a
sustained healthy run (>2min) resets the backoff. One heartbeat log line
per ~5min while healthy — no log spam.

## Quickshell bar button

Canonical snippet: `../quickshell/BrowserToggle.snippet.qml`. Installed into
`~/.config/quickshell/ii/modules/ii/bar/UtilButtons.qml` (RowLayout tail).
Quickshell reloads the config live.

## Agent display + interactive viewer (Forge 2026-09-21)

The keeper Chromium renders on an **isolated virtual display** — never in
the Architect's Hyprland session. (Root cause of the 2026-09-21 takeover: keeper.sh
exported `WAYLAND_DISPLAY=wayland-1`, so agent windows stole his mouse and
focus.)

- `agent-display` — `Xvnc :99`, RFB on `127.0.0.1:5900` only (`-localhost`),
  VNC password auth via `/home/toxic/.browserless/vncpasswd` (0600, the Architect's —
  never rotated, never stored anywhere else).
- `agent-viewer` — websockify serving stock noVNC on **`127.0.0.1:6080`
  (loopback-only)**. The viewer is **INTERACTIVE**: noVNC defaults
  `view_only=false`, so the Architect can click, type, and take over the
  agent browser.
- External route (2026-09-21, Forge): tailnet-only via `tailscale serve`
  on `:8443` — `/agent-browser` -> `127.0.0.1:6080`. No funnel, no token gate.

Viewer URL: `https://github-mcp-host.tailc9ac71.ts.net:8443/agent-browser/vnc.html`

## CDP WebSocket Origin quirk (Lumen 2026-10-02)

CDP over the isolated display needs the Origin header allowed — see the
keeper source for the current handling. If `connectOverCDP` starts failing
with 403s, check this first.
