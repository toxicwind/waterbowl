import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { BrowserlessClient } from './client.js';
import { BrowserlessConfigSchema } from './types.js';
import dotenv from 'dotenv';

// Load environment variables
import { PersistentBrowser, errMsg, log } from "./persistent.js";

dotenv.config();

// Structured stderr logging (stdout is the MCP wire).
type McpLogLevel = "debug" | "info" | "warn" | "error" | "fatal";
function mlog(level: McpLogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  log(level, msg, { ...fields, component: "mcp" });
}

// Optional numeric tab argument from MCP tool args (undefined = last-active tab).
// NaN fails the zod check inside PersistentBrowser with a clear INVALID_ARGS.
function tabArg(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

class BrowserlessMCPServer {
  private server: Server;
  private client: BrowserlessClient | null = null;
  private persistent: PersistentBrowser;

  constructor() {
    this.server = new Server(
      {
        name: 'browserless-mcp',
        version: "1.3.0",
      }
    );

    this.persistent = new PersistentBrowser();
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    // Initialize Browserless client
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "persistent_tabs",
            description: "[keeper-first] List all tabs in the keeper Chromium: index, URL, title, which is active.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "persistent_new_tab",
            description: "[keeper-first] Open a new tab in the keeper Chromium (optionally to a URL) and make it active. Returns the tab info.",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "Optional http(s) or data: URL to open in the new tab" },
              },
            },
          },
          {
            name: "persistent_close_tab",
            description: "[keeper-first] Close a keeper tab by index (from persistent_tabs). Refuses to close the last tab.",
            inputSchema: {
              type: "object",
              properties: {
                tab: { type: "number", description: "Tab index from persistent_tabs" },
              },
              required: ["tab"],
            },
          },
          {
            name: "persistent_activate_tab",
            description: "[keeper-first] Bring a keeper tab to the front by index (from persistent_tabs).",
            inputSchema: {
              type: "object",
              properties: {
                tab: { type: "number", description: "Tab index from persistent_tabs" },
              },
              required: ["tab"],
            },
          },
          {
            name: "persistent_status",
            description: "[keeper-first] Status of the persistent keeper Chromium (CDP alive, keeper pid/state, last error). No initialize_browserless needed.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "persistent_navigate",
            description: "[keeper-first] Navigate the persistent keeper Chromium to a URL. Headed, logged-in profile, survives across tasks.",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
              required: ["url"],
            },
          },
          {
            name: "persistent_screenshot",
            description: "[keeper-first] Screenshot the current page of the persistent keeper Chromium.",
            inputSchema: {
              type: "object",
              properties: {
                fullPage: { type: "boolean", default: false },
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
            },
          },
          {
            name: "persistent_click",
            description: "[keeper-first] Click a CSS selector in the persistent keeper Chromium.",
            inputSchema: {
              type: "object",
              properties: {
                selector: { type: "string" },
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
              required: ["selector"],
            },
          },
          {
            name: "persistent_fill",
            description: "[keeper-first] Fill a CSS selector with text in the persistent keeper Chromium.",
            inputSchema: {
              type: "object",
              properties: {
                selector: { type: "string" },
                text: { type: "string" },
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
              required: ["selector", "text"],
            },
          },
          {
            name: "persistent_text",
            description: "[keeper-first] Get the visible text of the current page in the persistent keeper Chromium.",
            inputSchema: {
              type: "object",
              properties: {
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
            },
          },
          {
            name: "persistent_evaluate",
            description: "[keeper-first] Evaluate a JS expression in the persistent keeper Chromium page and return the result.",
            inputSchema: {
              type: "object",
              properties: {
                js: { type: "string" },
                tab: { type: "number", description: "Tab index from persistent_tabs; defaults to the last-active tab" },
              },
              required: ["js"],
            },
          },

          {
            name: 'initialize_browserless',
            description: 'Initialize connection to Browserless instance',
            inputSchema: {
              type: 'object',
              properties: {
                host: { type: 'string', default: '127.0.0.1' },
                port: { type: 'number', default: 25130 },
                token: { type: 'string' },
                protocol: { type: 'string', enum: ['http', 'https', 'ws', 'wss'], default: 'http' },
                timeout: { type: 'number', default: 30000 },
                concurrent: { type: 'number', default: 5 },
              },
              required: ['token'],
            },
          },
          {
            name: 'generate_pdf',
            description: 'Generate PDF from URL or HTML content',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                html: { type: 'string' },
                options: {
                  type: 'object',
                  properties: {
                    displayHeaderFooter: { type: 'boolean' },
                    printBackground: { type: 'boolean' },
                    format: { type: 'string' },
                    landscape: { type: 'boolean' },
                    margin: {
                      type: 'object',
                      properties: {
                        top: { type: 'string' },
                        bottom: { type: 'string' },
                        left: { type: 'string' },
                        right: { type: 'string' },
                      },
                    },
                  },
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'take_screenshot',
            description: 'Take screenshot of a webpage (ephemeral session via :25130; historically timed out under load on browserless.io v2.49.0 — prefer persistent_screenshot).',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                options: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
                    quality: { type: 'number' },
                    fullPage: { type: 'boolean' },
                    omitBackground: { type: 'boolean' },
                    clip: {
                      type: 'object',
                      properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        width: { type: 'number' },
                        height: { type: 'number' },
                      },
                    },
                  },
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'get_content',
            description: 'Extract rendered HTML content from a webpage',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                waitForSelector: {
                  type: 'object',
                  properties: {
                    selector: { type: 'string' },
                    timeout: { type: 'number' },
                  },
                },
                waitForFunction: {
                  type: 'object',
                  properties: {
                    fn: { type: 'string' },
                    timeout: { type: 'number' },
                  },
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'execute_function',
            description: 'Execute custom JavaScript function in browser context (ephemeral session via :25130; v2.49.0 expects a specific payload shape — 4xx likely; prefer persistent_evaluate).',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                context: { type: 'object' },
              },
              required: ['code'],
            },
          },
          {
            name: 'download_files',
            description: 'Handle file downloads (thin wrapper over :25130; behavior depends on the server build).',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                context: { type: 'object' },
              },
              required: ['code'],
            },
          },
          {
            name: 'export_page',
            description: 'Export webpage with resources (NOT present in the browserless.io v2.49.0 build — expect 404).',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                headers: { type: 'object' },
                bestAttempt: { type: 'boolean' },
              },
              required: ['url'],
            },
          },
          {
            name: 'run_performance_audit',
            description: 'Run Lighthouse performance audit (NOT present in the browserless.io v2.49.0 build — expect 404).',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                config: {
                  type: 'object',
                  properties: {
                    extends: { type: 'string' },
                    settings: { type: 'object' },
                  },
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'unblock',
            description: 'Bypass bot detection and anti-scraping measures',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                content: { type: 'boolean' },
                screenshot: { type: 'boolean' },
                stealth: { type: 'boolean' },
                blockAds: { type: 'boolean' },
                headers: { type: 'object' },
              },
              required: ['url'],
            },
          },
          {
            name: 'execute_browserql',
            description: 'Execute BrowserQL GraphQL queries',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                variables: { type: 'object' },
              },
              required: ['query'],
            },
          },
          {
            name: 'create_websocket_connection',
            description: 'Create WebSocket connection for Puppeteer/Playwright',
            inputSchema: {
              type: 'object',
              properties: {
                browser: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] },
                library: { type: 'string', enum: ['puppeteer', 'playwright'] },
                stealth: { type: 'boolean' },
                blockAds: { type: 'boolean' },
                viewport: {
                  type: 'object',
                  properties: {
                    width: { type: 'number' },
                    height: { type: 'number' },
                    deviceScaleFactor: { type: 'number' },
                    isMobile: { type: 'boolean' },
                    hasTouch: { type: 'boolean' },
                  },
                },
                userAgent: { type: 'string' },
                extraHTTPHeaders: { type: 'object' },
              },
            },
          },
          {
            name: 'get_health',
            description: 'Get health status of Browserless instance',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_sessions',
            description: 'Get active sessions',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_config',
            description: 'Get configuration',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_metrics',
            description: 'Get metrics',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
] as Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'initialize_browserless': {
            try {
              if (args && (args as any).token) {
                const config = BrowserlessConfigSchema.parse(args);
                this.client = new BrowserlessClient(config);
              }
            } catch {
              // Invalid token/config: fall through to keeper-direct persistent mode.
            }
            const status = await this.persistent.status();
            return {
              content: [
                {
                  type: 'text',
                  text: `Browserless initialized: directly connected to persistent keeper (${status.browser || "Chromium"}) on ${status.cdpUrl}.`,
                },
              ],
            };
          }

          case 'generate_pdf': {
            if (this.client) {
              const result = await this.client.generatePdf(args as any);
              if (result.success && result.data) {
                return {
                  content: [
                    { type: 'text', text: `PDF generated successfully. Filename: ${result.data.filename}` },
                    { type: 'binary', mimeType: 'application/pdf', data: result.data.pdf.toString('base64') },
                  ],
                };
              }
            }
            throw new Error("PDF generation requires local print driver; use persistent_screenshot or initialize_browserless.");
          }

          case 'take_screenshot': {
            const url = (args as any)?.url;
            if (url) {
              await this.persistent.navigate(url);
            }
            const fullPage = Boolean((args as any)?.options?.fullPage);
            const base64 = await this.persistent.screenshot({ fullPage });
            return {
              content: [
                {
                  type: 'text',
                  text: `Screenshot taken successfully from persistent keeper headed browser.`,
                },
                {
                  type: 'image',
                  mimeType: `image/png`,
                  data: base64,
                },
              ],
            };
          }

          case 'get_content': {
            const url = (args as any)?.url;
            if (url) {
              await this.persistent.navigate(url);
            }
            const data = await this.persistent.content();
            return {
              content: [
                {
                  type: 'text',
                  text: `Content extracted successfully from ${data.url}`,
                },
                {
                  type: 'text',
                  text: `Title: ${data.title}`,
                },
                {
                  type: 'text',
                  text: data.html,
                },
              ],
            };
          }

          case 'execute_function': {
            const code = (args as any)?.code;
            if (!code) throw new Error("Argument 'code' is required");
            const result = await this.persistent.evaluate(code);
            return {
              content: [
                {
                  type: 'text',
                  text: `Function executed successfully on persistent keeper browser.`,
                },
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'download_files': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.downloadFiles(args as any);
            if (result.success && result.data) {
              const content = [
                {
                  type: 'text',
                  text: `Downloaded ${result.data.files.length} files successfully.`,
                },
              ];

              for (const file of result.data.files) {
                content.push({
                  type: 'binary',
                  mimeType: file.type,
                  data: file.data.toString('base64'),
                } as any);
              }

              return { content };
            } else {
              throw new Error(result.error || 'Failed to download files');
            }
          }

          case 'export_page': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.exportPage(args as any);
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Page exported successfully with ${result.data.resources.length} resources.`,
                  },
                  {
                    type: 'text',
                    text: result.data.html,
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to export page');
            }
          }

          case 'run_performance_audit': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.runPerformanceAudit(args as any);
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Performance audit completed successfully.',
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to run performance audit');
            }
          }

          case 'unblock': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.unblock(args as any);
            if (result.success && result.data) {
              const content = [
                {
                  type: 'text',
                  text: 'Unblock operation completed successfully.',
                },
              ];

              if (result.data.content) {
                content.push({
                  type: 'text',
                  text: result.data.content,
                });
              }

              if (result.data.screenshot) {
                content.push({
                  type: 'binary',
                  mimeType: 'image/png',
                  data: result.data.screenshot.toString('base64'),
                } as any);
              }

              return { content };
            } else {
              throw new Error(result.error || 'Failed to unblock');
            }
          }

          case 'execute_browserql': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.executeBrowserQL(args as any);
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'BrowserQL query executed successfully.',
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to execute BrowserQL query');
            }
          }

          case 'create_websocket_connection': {
            if (!args) throw new Error('Arguments are required');
            const result = await this.client!.createWebSocketConnection(args as any);
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `WebSocket connection created successfully. Session ID: ${result.data.sessionId}`,
                  },
                  {
                    type: 'text',
                    text: `Browser WebSocket endpoint: ${result.data.browserWSEndpoint}`,
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to create WebSocket connection');
            }
          }

          case 'get_health': {
            const result = await this.client!.getHealth();
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: "Health: see JSON below",
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to get health status');
            }
          }

          case 'get_sessions': {
            const result = await this.client!.getSessions();
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Found ${result.data.length} active sessions.`,
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to get sessions');
            }
          }

          case 'get_config': {
            const result = await this.client!.getConfig();
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Current configuration:',
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to get configuration');
            }
          }

          case 'get_metrics': {
            const result = await this.client!.getMetrics();
            if (result.success && result.data) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Current metrics:',
                  },
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(result.error || 'Failed to get metrics');
            }
          }

          case "persistent_status": {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await this.persistent.status(), null, 2),
                },
              ],
            };
          }

          case "persistent_navigate": {
            const nav = await this.persistent.navigate((args as any)?.url, { tab: tabArg((args as any)?.tab) });
            return {
              content: [
                {
                  type: "text",
                  text: "Navigated tab " + nav.tab + ": " + nav.title + " - " + nav.url,
                },
              ],
            };
          }

          case "persistent_screenshot": {
            const png = await this.persistent.screenshot({ fullPage: !!(args as any)?.fullPage, tab: tabArg((args as any)?.tab) });
            return {
              content: [
                {
                  type: "text",
                  text: "Screenshot of the persistent keeper browser:",
                },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: png,
                },
              ],
            };
          }

          case "persistent_click": {
            const clicked = await this.persistent.click((args as any)?.selector, { tab: tabArg((args as any)?.tab) });
            return {
              content: [
                {
                  type: "text",
                  text: "Clicked tab " + clicked.tab + ": " + clicked.selector,
                },
              ],
            };
          }

          case "persistent_fill": {
            const filled = await this.persistent.fill((args as any)?.selector, (args as any)?.text, { tab: tabArg((args as any)?.tab) });
            return {
              content: [
                {
                  type: "text",
                  text: "Filled tab " + filled.tab + ": " + filled.selector,
                },
              ],
            };
          }

          case "persistent_text": {
            return {
              content: [
                {
                  type: "text",
                  text: await this.persistent.pageText({ tab: tabArg((args as any)?.tab) }),
                },
              ],
            };
          }

          case "persistent_evaluate": {
            const val = await this.persistent.evaluate((args as any)?.js, { tab: tabArg((args as any)?.tab) });
            return {
              content: [
                {
                  type: "text",
                  text: typeof val === "string" ? val : JSON.stringify(val),
                },
              ],
            };
          }

          case "persistent_tabs": {
            const tabs = await this.persistent.tabs();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(tabs, null, 2),
                },
              ],
            };
          }

          case "persistent_new_tab": {
            const t = await this.persistent.newTab((args as any)?.url);
            return {
              content: [
                {
                  type: "text",
                  text: `New tab ${t.index}: ${t.title} - ${t.url}`,
                },
              ],
            };
          }

          case "persistent_close_tab": {
            const r = await this.persistent.closeTab(tabArg((args as any)?.tab) as number);
            return {
              content: [
                {
                  type: "text",
                  text: `Closed tab ${r.closed}; ${r.remaining} tab(s) remain.`,
                },
              ],
            };
          }

          case "persistent_activate_tab": {
            const t = await this.persistent.activateTab(tabArg((args as any)?.tab) as number);
            return {
              content: [
                {
                  type: "text",
                  text: `Active tab ${t.index}: ${t.title} - ${t.url}`,
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        throw new Error(`Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  async run() {
    await probeKeeperOrDie();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    mlog("info", "browserless-mcp started", {
      version: "1.3.0",
      keeperCdp: process.env.BROWSER_KEEPER_CDP || "http://127.0.0.1:9223",
    });
    // Shut down cleanly when stdin closes (MCP client disconnect/EOF).
    process.stdin.on('end', () => { void this.shutdown().then(() => process.exit(0)); });
    process.stdin.on('close', () => { void this.shutdown().then(() => process.exit(0)); });
  }

  /** Graceful shutdown: drop the keeper CDP session, then close the MCP server. */
  async shutdown() {
    mlog("info", "shutting down browserless-mcp");
    try {
      await this.persistent.disconnect();
    } catch (e) {
      mlog("warn", "keeper disconnect failed during shutdown", { error: errMsg(e) });
    }
    try {
      await this.server.close();
    } catch (e) {
      mlog("warn", "MCP server close failed during shutdown", { error: errMsg(e) });
    }
  }
}

/**
 * Startup readiness probe: the persistent_* tools are the first-class path,
 * so refuse to start half-working when the keeper is down. Bypass only with
 * BROWSER_MCP_ALLOW_NO_KEEPER=1 (maintenance).
 */
async function probeKeeperOrDie(): Promise<void> {
  const cdp = process.env.BROWSER_KEEPER_CDP || "http://127.0.0.1:9223";
  if (process.env.BROWSER_MCP_ALLOW_NO_KEEPER === "1") {
    mlog("warn", "keeper readiness probe skipped (BROWSER_MCP_ALLOW_NO_KEEPER=1)");
    return;
  }
  try {
    const res = await fetch(cdp + "/json/version", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = (await res.json()) as { Browser?: string };
    mlog("info", "keeper readiness probe OK", { cdp, browser: v?.Browser ?? "unknown" });
  } catch (e) {
    mlog(
      "fatal",
      "keeper CDP not answering — refusing to start half-working",
      {
        cdp,
        error: errMsg(e),
        hint: "start the keeper first: pitchfork start browser-keeper (or set BROWSER_MCP_ALLOW_NO_KEEPER=1)",
      }
    );
    process.exit(1);
  }
}

// Start the server
const server = new BrowserlessMCPServer();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    mlog("info", `${sig} received`);
    void server
      .shutdown()
      .catch((e) => mlog("error", "shutdown error", { error: errMsg(e) }))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
server.run().catch((e) => {
  mlog("fatal", "startup failed", { error: errMsg(e) });
  process.exit(1);
});
