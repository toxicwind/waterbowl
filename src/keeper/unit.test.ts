import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import {
  CDP_PORT,
  CDP_BASE,
  CDP_VERSION_URL,
  PROFILE_DIR,
  KEEPER_DIR,
  STATUS_FILE,
  DEFAULT_DISPLAY,
  readCdpPort,
  readProfileDir,
  jestResetEnv,
  CHROMIUM_ARGS,
} from "./config.js";
import { writeStatus, cdpAlive } from "./status.js";
import {
  chromiumArgsFor,
  resolveChromiumExecutable,
  spawnChromium,
} from "./browser.js";
import { runSupervisor, type SupervisorOptions } from "./supervisor.js";

// ============================================================================
// config.ts — constants
// ============================================================================

describe("config — constants", () => {
  test("CDP_PORT is a positive integer", () => {
    expect(Number.isInteger(CDP_PORT)).toBe(true);
    expect(CDP_PORT).toBeGreaterThan(0);
  });

  test("CDP_BASE is http://127.0.0.1:<CDP_PORT>", () => {
    expect(CDP_BASE).toBe(`http://127.0.0.1:${CDP_PORT}`);
  });

  test("CDP_VERSION_URL is /json/version under CDP_BASE", () => {
    expect(CDP_VERSION_URL).toBe(`${CDP_BASE}/json/version`);
  });

  test("PROFILE_DIR is a browserless profile path", () => {
    expect(PROFILE_DIR).toContain(".browserless/profiles/");
  });

  test("STATUS_FILE lives under KEEPER_DIR", () => {
    expect(STATUS_FILE.startsWith(KEEPER_DIR)).toBe(true);
    expect(STATUS_FILE.endsWith("/status.json")).toBe(true);
  });

  test("DEFAULT_DISPLAY is :99", () => {
    expect(DEFAULT_DISPLAY).toBe(":99");
  });
});

describe("config — CHROMIUM_ARGS", () => {
  test("includes --no-sandbox", () => {
    expect(CHROMIUM_ARGS).toContain("--no-sandbox");
  });

  test("includes --disable-dev-shm-usage", () => {
    expect(CHROMIUM_ARGS).toContain("--disable-dev-shm-usage");
  });

  test("includes --disable-blink-features=AutomationControlled", () => {
    expect(CHROMIUM_ARGS).toContain("--disable-blink-features=AutomationControlled");
  });

  test("includes --ozone-platform=x11", () => {
    expect(CHROMIUM_ARGS).toContain("--ozone-platform=x11");
  });

  test("includes --no-first-run", () => {
    expect(CHROMIUM_ARGS).toContain("--no-first-run");
  });

  test("includes --no-default-browser-check", () => {
    expect(CHROMIUM_ARGS).toContain("--no-default-browser-check");
  });

  test("includes --window-position=0,0", () => {
    expect(CHROMIUM_ARGS).toContain("--window-position=0,0");
  });

  test("includes --window-size=1600,900", () => {
    expect(CHROMIUM_ARGS).toContain("--window-size=1600,900");
  });

  test("remote-debugging-port matches CDP_PORT", () => {
    expect(CHROMIUM_ARGS).toContain(`--remote-debugging-port=${CDP_PORT}`);
  });

  test("user-data-dir matches PROFILE_DIR", () => {
    expect(CHROMIUM_ARGS).toContain(`--user-data-dir=${PROFILE_DIR}`);
  });

  test("defines at least 10 args", () => {
    expect(CHROMIUM_ARGS.length).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================================
// config.ts — env-read functions (in-process, call-time env)
// ============================================================================

describe("config — readCdpPort/readProfileDir (env override contract)", () => {
  const saved = {
    cdp: process.env.CUPRITE_CDP_PORT,
    profile: process.env.KEEPER_PROFILE_DIR,
  };

  test("readCdpPort defaults to 25234", () => {
    delete process.env.CUPRITE_CDP_PORT;
    expect(readCdpPort()).toBe(25234);
    if (saved.cdp !== undefined) process.env.CUPRITE_CDP_PORT = saved.cdp;
  });

  test("readCdpPort honors CUPRITE_CDP_PORT", () => {
    process.env.CUPRITE_CDP_PORT = "9999";
    expect(readCdpPort()).toBe(9999);
    if (saved.cdp !== undefined) process.env.CUPRITE_CDP_PORT = saved.cdp;
    else delete process.env.CUPRITE_CDP_PORT;
  });

  test("readProfileDir defaults to nv-audit profile", () => {
    delete process.env.KEEPER_PROFILE_DIR;
    expect(readProfileDir()).toBe("/home/toxic/.browserless/profiles/nv-audit");
    if (saved.profile !== undefined) process.env.KEEPER_PROFILE_DIR = saved.profile;
  });

  test("readProfileDir honors KEEPER_PROFILE_DIR", () => {
    process.env.KEEPER_PROFILE_DIR = "/tmp/custom-profile";
    expect(readProfileDir()).toBe("/tmp/custom-profile");
    if (saved.profile !== undefined) process.env.KEEPER_PROFILE_DIR = saved.profile;
    else delete process.env.KEEPER_PROFILE_DIR;
  });
});

describe("config — jestResetEnv", () => {
  test("forces DISPLAY=:99 even when inherited :0", () => {
    process.env.DISPLAY = ":0";
    jestResetEnv();
    expect(process.env.DISPLAY).toBe(":99");
  });

  test("clears WAYLAND_DISPLAY when set", () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    jestResetEnv();
    expect(process.env.WAYLAND_DISPLAY).toBeUndefined();
  });

  test("preserves an existing XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/custom/xdg";
    jestResetEnv();
    expect(process.env.XDG_RUNTIME_DIR).toBe("/custom/xdg");
  });

  test("defaults XDG_RUNTIME_DIR when unset", () => {
    delete process.env.XDG_RUNTIME_DIR;
    jestResetEnv();
    expect(process.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  });

  test("is idempotent under repeated calls", () => {
    process.env.DISPLAY = ":1";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    jestResetEnv();
    jestResetEnv();
    expect(process.env.DISPLAY).toBe(":99");
    expect(process.env.WAYLAND_DISPLAY).toBeUndefined();
  });
});

// ============================================================================
// browser.ts — chromiumArgsFor
// ============================================================================

describe("browser — chromiumArgsFor", () => {
  test("appends extra args to base CHROMIUM_ARGS", () => {
    expect(chromiumArgsFor(["--disable-gpu"])).toEqual([
      ...CHROMIUM_ARGS,
      "--disable-gpu",
    ]);
  });

  test("no extra args returns a copy of CHROMIUM_ARGS", () => {
    expect(chromiumArgsFor()).toEqual([...CHROMIUM_ARGS]);
  });

  test("returns a fresh array, never the CHROMIUM_ARGS reference", () => {
    const args = chromiumArgsFor();
    expect(args).not.toBe(CHROMIUM_ARGS);
    args.push("mutated");
    expect(CHROMIUM_ARGS).not.toContain("mutated");
  });

  test("appends multiple extras preserving order", () => {
    const args = chromiumArgsFor(["--extra-1", "--extra-2"]);
    expect(args[args.length - 2]).toBe("--extra-1");
    expect(args[args.length - 1]).toBe("--extra-2");
  });
});

// ============================================================================
// browser.ts — resolveChromiumExecutable
// ============================================================================

describe("browser — resolveChromiumExecutable", () => {
  const saved = {
    keeper: process.env.KEEPER_CHROMIUM_EXECUTABLE,
    pw: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };

  test("uses KEEPER_CHROMIUM_EXECUTABLE when the file exists", () => {
    const testBin = join(tmpdir(), "fake-chrome-" + Date.now());
    writeFileSync(testBin, "#!/bin/sh\n");
    try {
      process.env.KEEPER_CHROMIUM_EXECUTABLE = testBin;
      expect(resolveChromiumExecutable()).toBe(testBin);
    } finally {
      rmSync(testBin, { force: true });
      if (saved.keeper !== undefined) process.env.KEEPER_CHROMIUM_EXECUTABLE = saved.keeper;
      else delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
    }
  });

  test("throws 'no chromium' when the browser cache is empty", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "empty-playwright-"));
    try {
      delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      process.env.PLAYWRIGHT_BROWSERS_PATH = emptyDir;
      expect(() => resolveChromiumExecutable()).toThrow(/no chromium/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      if (saved.keeper !== undefined) process.env.KEEPER_CHROMIUM_EXECUTABLE = saved.keeper;
      else delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      if (saved.pw !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = saved.pw;
      else delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
  });

  test("throws 'no chromium' when the cache dir is unreadable/missing", () => {
    try {
      delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      process.env.PLAYWRIGHT_BROWSERS_PATH = "/nonexistent/playwright-cache";
      expect(() => resolveChromiumExecutable()).toThrow(/no chromium/);
    } finally {
      if (saved.keeper !== undefined) process.env.KEEPER_CHROMIUM_EXECUTABLE = saved.keeper;
      else delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      if (saved.pw !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = saved.pw;
      else delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
  });

  test("resolves the real playwright chromium on this box (kernel truth)", () => {
    try {
      delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      const bin = resolveChromiumExecutable();
      expect(bin.length).toBeGreaterThan(0);
      expect(bin).toMatch(/chromium-/);
    } finally {
      if (saved.keeper !== undefined) process.env.KEEPER_CHROMIUM_EXECUTABLE = saved.keeper;
      else delete process.env.KEEPER_CHROMIUM_EXECUTABLE;
      if (saved.pw !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = saved.pw;
      else delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
  });
});

// ============================================================================
// browser.ts — spawnChromium
// ============================================================================

describe("browser — spawnChromium", () => {
  test("spawns a child, drains stderr incl. DevTools marker, and exits cleanly", async () => {
    const fakeBin = join(tmpdir(), "fake-chrome-bin-" + Date.now());
    // Emit stderr lines (one with the DevTools marker) so the drain loop's
    // line-buffering + CDP-readiness log path is exercised, then exit.
    writeFileSync(
      fakeBin,
      '#!/bin/sh\necho "chromium stderr line" >&2\necho "DevTools listening on ws://127.0.0.1:9222/devtools" >&2\nsleep 0.3\nexit 0\n',
      { mode: 0o755 },
    );
    try {
      const proc = spawnChromium(fakeBin);
      expect(proc.pid).toBeGreaterThan(0);
      // The child exits on its own after flushing stderr; awaiting the real
      // exit signal guarantees the async drainer read + line-buffered both
      // lines (stderr closes on exit). Fake-timer control can't drive a real
      // spawned process, so this integration wait is the deterministic signal.
      await proc.exited;
      expect(proc.exitCode).toBe(0);
    } finally {
      rmSync(fakeBin, { force: true });
    }
  }, 5000);
});

// ============================================================================
// status.ts — writeStatus
// ============================================================================

describe("status — writeStatus (no-throw contract)", () => {
  const base = {
    cdp: CDP_BASE,
    startedAt: new Date().toISOString(),
    relaunchCount: 0,
    lastError: null as string | null,
  };

  test("starting state with null childPid", () => {
    expect(() => writeStatus({ ...base, childPid: null, state: "starting" })).not.toThrow();
  });

  test("up state with childPid", () => {
    expect(() => writeStatus({ ...base, childPid: 4242, state: "up" })).not.toThrow();
  });

  test("failed state records lastError", () => {
    expect(() =>
      writeStatus({ ...base, childPid: 4242, state: "failed", relaunchCount: 5, lastError: "CDP timeout" }),
    ).not.toThrow();
  });

  test("relaunching state with nonzero counter", () => {
    expect(() =>
      writeStatus({ ...base, childPid: 4242, state: "relaunching", relaunchCount: 3, lastError: "CDP unresponsive" }),
    ).not.toThrow();
  });

  test("very long error message does not throw", () => {
    expect(() =>
      writeStatus({ ...base, childPid: 1, state: "failed", relaunchCount: 999, lastError: "A".repeat(10000) }),
    ).not.toThrow();
  });

  test("empty state string is accepted", () => {
    expect(() => writeStatus({ ...base, childPid: null, state: "" })).not.toThrow();
  });
});

describe("status — writeStatus file contract", () => {
  let dir: string;

  test("writes schema-complete JSON to an explicit path", () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-status-"));
    const file = join(dir, "keeper", "status.json");
    writeStatus(
      {
        cdp: "http://127.0.0.1:9999",
        childPid: 777,
        state: "up",
        startedAt: "2026-01-01T00:00:00Z",
        relaunchCount: 4,
        lastError: null,
      },
      file,
    );
    const payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(payload.cdp).toBe("http://127.0.0.1:9999");
    expect(payload.pid).toBe(777);
    expect(payload.state).toBe("up");
    expect(payload.profile).toBe(PROFILE_DIR);
    expect(payload.started_at).toBe("2026-01-01T00:00:00Z");
    expect(payload.relaunch_count).toBe(4);
    expect(payload.last_error).toBeNull();
    expect(typeof payload.at).toBe("string");
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to process.pid when childPid is null", () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-status-"));
    const file = join(dir, "status.json");
    writeStatus(
      {
        cdp: "http://x",
        childPid: null,
        state: "starting",
        startedAt: "2026-01-01T00:00:00Z",
        relaunchCount: 0,
        lastError: null,
      },
      file,
    );
    const payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(payload.pid).toBe(process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not throw when the target dir is unwritable", () => {
    expect(() =>
      writeStatus(
        {
          cdp: "http://x",
          childPid: 1,
          state: "up",
          startedAt: "2026-01-01T00:00:00Z",
          relaunchCount: 0,
          lastError: null,
        },
        "/proc/1/keeper-status.json",
      ),
    ).not.toThrow();
  });
});

// ============================================================================
// status.ts — cdpAlive
// ============================================================================

describe("status — cdpAlive", () => {
  test("returns true on HTTP 200", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
    try {
      expect(await cdpAlive(`http://127.0.0.1:${server.port}`)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("returns false on non-200", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      expect(await cdpAlive(`http://127.0.0.1:${server.port}`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("returns false when the endpoint is unreachable", async () => {
    expect(await cdpAlive("http://127.0.0.1:1")).toBe(false);
  });
});

// ============================================================================
// supervisor.ts — runSupervisor state machine (fast seams)
// ============================================================================

interface TestChild {
  pid: number;
  kill(): void;
  readonly exitCode: number | null;
}

type SpawnHook = () => TestChild | null;

function readState(file: string): string | null {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { state: string }).state;
  } catch {
    return null;
  }
}

function supervisorOpts(dir: string, extra: SupervisorOptions = {}): SupervisorOptions {
  return {
    statusFile: join(dir, "status.json"),
    launchProbeMs: 5,
    launchProbes: 3,
    heartbeatMs: 25,
    recycleGraceMs: 5,
    maxBackoffMs: 40,
    ...extra,
  };
}

function stableChild(pid = 1): TestChild {
  return { pid, kill() {}, get exitCode() { return null; } };
}

describe("supervisor — runSupervisor state machine", () => {
  let dir: string;

  test("clean stop: stopRequested true from the first check", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    let stopped = false;
    const states: (string | null)[] = [];
    await runSupervisor(
      {
        spawn: () => null,
        stopRequested: () => true,
        onStopped: () => {
          stopped = true;
          states.push(readState(join(dir, "status.json")));
        },
      },
      supervisorOpts(dir),
    );
    expect(stopped).toBe(true);
    expect(states.at(-1)).toBe("stopping");
    rmSync(dir, { recursive: true, force: true });
  });

  test("spawn failure: backoff branch runs and stop is honored", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    const file = join(dir, "status.json");
    const seen: (string | null)[] = [];
    let checks = 0;
    await runSupervisor(
      {
        spawn: () => null,
        stopRequested: () => {
          seen.push(readState(file));
          return ++checks > 6;
        },
        onStopped: () => seen.push(readState(file)),
      },
      supervisorOpts(dir),
    );
    expect(checks).toBeGreaterThan(6);
    expect(seen).toContain("starting");
    expect(seen).toContain("failed");
    expect(seen.at(-1)).toBe("stopping");
    rmSync(dir, { recursive: true, force: true });
  });

  test("CDP never reachable: child killed after launch probes, backoff, respawn", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    const file = join(dir, "status.json");
    let killCalls = 0;
    let spawns = 0;
    const seen: (string | null)[] = [];
    let checks = 0;
    await runSupervisor(
      {
        spawn: () => {
          spawns++;
          return { pid: 2, kill: () => killCalls++, get exitCode() { return null; } };
        },
        stopRequested: () => {
          seen.push(readState(file));
          return ++checks > 10;
        },
        onStopped: () => seen.push(readState(file)),
      },
      supervisorOpts(dir, { cdpProbe: async () => false, launchProbes: 2 }),
    );
    expect(killCalls).toBeGreaterThan(0);
    expect(spawns).toBeGreaterThanOrEqual(2);
    expect(seen).toContain("failed");
    expect(seen.at(-1)).toBe("stopping");
    rmSync(dir, { recursive: true, force: true });
  });

  test("child dies before CDP comes up: exitCode path kills it", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    let killCalls = 0;
    let checks = 0;
    await runSupervisor(
      {
        spawn: () => ({
          pid: 3,
          kill: () => killCalls++,
          get exitCode() { return 1; }, // died before CDP
        }),
        stopRequested: () => ++checks > 10,
      },
      // cdpProbe must ALSO be false: when the child is dead but CDP is alive,
      // the supervisor correctly rescues the launch (CDP truth wins — the
      // singleton-war protection). Only a dead child + dead CDP reaches kill.
      supervisorOpts(dir, { cdpProbe: async () => false }),
    );
    expect(killCalls).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("healthy: probes CDP true at launch, heartbeats, stops on request", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    const file = join(dir, "status.json");
    let probes = 0;
    let stop = false;
    let spawns = 0;
    const seen: (string | null)[] = [];
    await runSupervisor(
      {
        spawn: () => {
          spawns++;
          return stableChild(4);
        },
        stopRequested: () => {
          seen.push(readState(file));
          return stop;
        },
        onStopped: () => seen.push(readState(file)),
      },
      supervisorOpts(dir, {
        cdpProbe: async () => {
          probes++;
          if (probes >= 3) stop = true;
          return true;
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(seen).toContain("up");
    expect(seen.at(-1)).toBe("stopping");
    rmSync(dir, { recursive: true, force: true });
  });

  test("recycle: CDP loss during heartbeat kills, relaunches, then stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "cuprite-sup-"));
    const file = join(dir, "status.json");
    let probes = 0;
    let stop = false;
    let killCalls = 0;
    let spawns = 0;
    const seen: (string | null)[] = [];
    await runSupervisor(
      {
        spawn: () => {
          spawns++;
          return { pid: 5, kill: () => killCalls++, get exitCode() { return null; } };
        },
        stopRequested: () => {
          seen.push(readState(file));
          return stop;
        },
        onStopped: () => seen.push(readState(file)),
      },
      supervisorOpts(dir, {
        cdpProbe: async () => {
          probes++;
          // launch probe OK; heartbeat probe fails => recycle; then stop.
          if (probes === 1) return true;
          if (probes === 2) return false;
          stop = true;
          return true;
        },
      }),
    );
    expect(spawns).toBe(2);
    expect(killCalls).toBe(1);
    expect(seen).toContain("relaunching");
    expect(seen.at(-1)).toBe("stopping");
    rmSync(dir, { recursive: true, force: true });
  });
});