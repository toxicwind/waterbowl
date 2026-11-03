# waterbowl

One persistent shared headed Chromium for the whole estate, plus the
keeper-first MCP server that drives it — the deep-red copper-oxide core of the
estate's agent browser lane. First-class citizen of the geode pen:
`pens/geode/products/waterbowl`.

- **The daemon** — one persistent headed Chromium. Owns
  `/home/toxic/.browserless/profiles/nv-audit` exclusively, exposes CDP on
  `127.0.0.1:25234`, writes `/home/toxic/.browserless/waterbowl/status.json`,
  relaunches Chromium if it dies. Single-instance: exits if CDP already
  answers. Supervised as `[daemons.waterbowl]` (pitchfork) on Xvnc `:99`.
- **The MCP server** (`src/`, built to `dist/`) — stdio MCP server
  (`browserless-mcp` 1.3.0). Eleven `[keeper-first]` `persistent_*` tools
  attach via `chromium.connectOverCDP` to waterbowl — no
  `initialize_browserless` needed, logins/tabs/state survive across tasks.
- **The surface** — the DP-2 quickshell `ii` section: top slot = this
  browser, bottom slot = normal grid. Mouse-first, never steals focus.

## What it is

`waterbowl` (ex `browser-keeper`) is the estate's shared browser: a single
long-lived Chromium that every agent drives through MCP instead of each
spawning its own ephemeral session. The daemon keeps the browser alive; the
MCP server is the control plane. Both live here, built and versioned
together.

> Supersedes (retired 2026-11-02): `browser-keeper` (:9223), `skopos`
> (:25233) and `skopos-failover` — the split-brain (two Chromia, 27 relaunch
> spiral, status.json tracking the failover). One daemon, one port: :25234.

## Layout

- `keeper.cjs` — legacy CJS daemon (kept for reference; the live daemon is
  `bin/waterbowl.ts`).
- `bin/waterbowl.ts` — thin bun entry; supervisor lives in `src/keeper/`
  (`browser.ts`, `supervisor.ts`, `status.ts`, `config.ts`).
- `waterbowl.sh` — pitchfork launcher: unsets `WAYLAND_DISPLAY`, sets
  `DISPLAY=:99`, execs the entry (the keeper never renders in the
  Architect's Hyprland session).
- `pitchfork.fragment.toml` — `[daemons.waterbowl]`; merge into
  `/home/toxic/pens/estate/pitchfork.toml` (monolith is truth).
- `browser-toggle.sh` — shows/hides the **VNC viewer** window (the TigerVNC
  client that renders the isolated keeper display).

## Ports

| Surface | Port |
|---|---|
| CDP (health + MCP attach) | 25234 |
| ready probe | 25236 (reserved) |
| Xvnc display | :99 (RFB 5900) |
| noVNC websocket | 6080 |

## Run

```bash
# supervisor (preferred)
cd /home/toxic/pens/estate && ./bin/pitchfork-restart waterbowl --cold

# direct
DISPLAY=:99 XDG_RUNTIME_DIR=/run/user/1000 WATERBOWL_CDP_PORT=25234 \
  bun run bin/waterbowl.ts

# ready check
curl -sf http://127.0.0.1:25234/json/version
```

It needs the Xvnc `:99` display (`agent-display`) — the daemon declares that
dependency so it never relaunch-loops on "Missing X server".

## MCP registration

Thresher's `mcp_config.json` (`pens/estate/config/thresher/`) carries the
waterbowl entry: `bun dist/index.js` with

```json
{ "WATERBOWL_CDP": "http://127.0.0.1:25234" }
```

(`dist/` is the built MCP server; rebuild with `bun run build` after editing
`src/`.)

## Security

- Loopback-only CDP (`127.0.0.1:25234`) — never exposed on the LAN.
- VNC password at `/home/toxic/.browserless/vncpasswd`; noVNC loopback-only,
  tailnet via `tailscale serve :8443` if ever needed.
- Never paste tokens into agent sessions; the waterbowl profile persists
  sessions across tasks by design (cookies auto-backup to
  `.browserless/cookies-backup.json`).

## Tests

```bash
bun test src/keeper/unit.test.ts   # supervisor/config unit suite
bun run smoke/keeper-smoke.mjs     # live smoke against :25234
```

## Ownership

Geode pen (inference-plane browser lane). Successor of
`pens/ranch/products/keeper` and the skopos keeper — canonical source now.