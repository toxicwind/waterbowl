# kennel — pen doctrine (geode)

Persistent shared headed browser + agent surface. Refines, never contradicts,
`/home/toxic/pens/geode/AGENTS.md` / `/home/toxic/AGENTS.md`.

## Core facts

- One Chromium, one owner: profile `nv-audit`, CDP `127.0.0.1:25234`,
  status `/home/toxic/.browserless/kennel/status.json`. Single-instance.
- Supervisor: `[daemons.kennel]` in the estate pitchfork monolith;
  Xvnc `:99` display is a hard dependency (agent-display).
- MCP server (`src/index.ts` → `dist/`) is the `browserless` upstream in
  thresher: eleven `persistent_*` tools (`chromium.connectOverCDP`).
- Portrait DP-2 surface (quickshell `ii`): top = kennel browser, bottom =
  normal grid. Mouse-first; NEVER steals the architect's focus.

## Retired names (do not resurrect)

`browser-keeper` (:9223), `skopos` (:25233), `skopos-failover`,
`KEEPER_*`/`BROWSER_KEEPER_*` env names. Split-brain cost the estate a
27-relaunch spiral; one daemon, one port is the contract. Env prefix:
`KENNEL_CDP_PORT` / `KENNEL_CDP`.

## Rules

- Port changes go through the estate Port SSOT (`config/ports.env`) — never
  a bare hardcode. Default 25234, ready 25236 reserved.
- Never paste tokens into sessions; cookies auto-backup to
  `.browserless/cookies-backup.json` (vault sync on launch).
- The keeper's Chromium is on Xvnc `:99`, never on `:0`/Wayland.