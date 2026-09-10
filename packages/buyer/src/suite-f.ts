/**
 * Suite F — client compatibility. Each case pays for the same thing through a different client
 * stack and records whether it worked, so the matrix reports evidence rather than package
 * existence.
 *
 *   pnpm clients --case mcp     # F2 + F3: Agents SDK withX402 / withX402Client over MCP
 *   pnpm clients --case fetch   # F1: @x402/fetch against the HTTP seller
 *   pnpm clients --case all
 *
 * F2 and F3 are one case, not two. The plan lists "Agents SDK withX402Client" and "a paidTool MCP
 * endpoint" separately, but `agents/x402` exports both halves of a single MCP integration:
 * withX402(server) adds the paidTool method, and withX402Client(client) pays for what it exposes.
 * There is no way to exercise one without the other.
 *
 * The MCP server runs in this process rather than on the deployed Worker. MCP carries payment in
 * JSON-RPC `_meta`, not in HTTP headers, so it needs an MCP server and cannot reuse the seller's
 * routes at all — which is itself the finding this case reports.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { round, type BuyerRecord, type Suite } from "@x402-bench/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withX402, withX402Client } from "agents/x402";
import { createContext, paidRequest } from "./client.ts";
import { isMain, parseArgs, str } from "./cli.ts";
import { BUYER_DIR, loadConfig, packageVersions, REPO_ROOT, type BuyerConfig } from "./config.ts";
import { appendRecord } from "./recorder.ts";
import { loadOrCreateAccount } from "./wallet.ts";

const CASES = ["mcp", "fetch", "mpp"] as const;
type Case = (typeof CASES)[number];

/** Which Suite F test each case answers. */
const TEST_ID: Record<Case, string> = { mcp: "F2-F3", fetch: "F1", mpp: "F6" };

const TOOL_NAME = "premium_snack_info";
const PRICE_USD = 0.001;

/**
 * The seller's payTo address. Read from the seller's gitignored .dev.vars because the MCP server
 * here stands in for the seller, and paying a different address than the rest of the bench would
 * make the wallet arithmetic in the report wrong.
 */
function payToFromDevVars(): `0x${string}` {
  const file = path.join(REPO_ROOT, "packages/seller/.dev.vars");
  if (!existsSync(file)) throw new Error(`Need ${file} for PAY_TO.`);
  const match = /^PAY_TO=(.*)$/m.exec(readFileSync(file, "utf8"));
  const value = match?.[1]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("PAY_TO in packages/seller/.dev.vars is missing or not an address.");
  }
  return value as `0x${string}`;
}

/** Start the paid MCP server on an ephemeral port. Returns the port and a stop function. */
async function startPaidMcpServer(cfg: BuyerConfig): Promise<{ port: number; stop: () => Promise<void> }> {
  const base = new McpServer({ name: "x402-bench-paid-mcp", version: "0.1.0" });
  const server = withX402(base, { network: cfg.network, recipient: payToFromDevVars() });

  // An empty parameter schema on purpose. `agents` declares zod ^4 while @x402/core declares
  // zod ^3, so a schema built here would cross a package boundary that may hold two different
  // zod instances; that is tested separately rather than being allowed to mask a payment failure.
  server.paidTool(TOOL_NAME, "Premium snack information, paid per call.", PRICE_USD, {}, {}, async () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ snack: "stroopwafel", stock: 42 }) }],
  }));

  // Transports are kept per session. A fresh transport per request loses the `initialize`
  // handshake, so the tool call that follows it is rejected with "Server not initialized" —
  // the payment never gets a chance to happen.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const http: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        // Annotated because the handler below refers to `transport` inside its own initializer.
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string): void => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    http.on("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const addr = http.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}

interface CaseOutcome {
  ok: boolean;
  totalMs: number;
  detail: string;
  error?: string;
  /** Set when the client reported a settlement, so the matrix can say money actually moved. */
  transaction?: string;
  /** How the payment reached the server: HTTP headers, or MCP _meta. */
  transport: string;
}

/** F2 + F3: pay for an MCP tool call through the Agents SDK client wrapper. */
async function runMcpCase(cfg: BuyerConfig): Promise<CaseOutcome> {
  const { account } = loadOrCreateAccount(cfg);
  const srv = await startPaidMcpServer(cfg);
  const started = performance.now();
  try {
    const raw = new Client({ name: "x402-bench-buyer", version: "0.1.0" });
    await raw.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
    const paid = withX402Client(raw, { account, network: cfg.network });

    // The first argument is the confirmation callback, not the params. Returning true approves
    // the payment; an agent running unattended has to answer this without a human.
    let requirementsSeen = 0;
    const result = await paid.callTool(
      async (requirements) => {
        requirementsSeen = requirements.length;
        return true;
      },
      { name: TOOL_NAME, arguments: {} },
    );

    const totalMs = round(performance.now() - started);
    const text = (result.content as { type: string; text?: string }[] | undefined)
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const meta = (result as { _meta?: Record<string, unknown> })._meta ?? {};
    const receipt = Object.entries(meta).find(([k]) => k.toLowerCase().includes("payment"))?.[1];
    const transaction =
      typeof receipt === "object" && receipt !== null
        ? ((receipt as { transaction?: string }).transaction ?? undefined)
        : undefined;

    await raw.close();
    return {
      ok: Boolean(text) && !result.isError,
      totalMs,
      detail: `${requirementsSeen} requirement(s) offered, content ${text ? "delivered" : "missing"}`,
      transaction,
      transport: "MCP _meta (JSON-RPC), not HTTP headers",
    };
  } catch (err) {
    return {
      ok: false,
      totalMs: round(performance.now() - started),
      detail: "failed",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      transport: "MCP _meta (JSON-RPC), not HTTP headers",
    };
  } finally {
    await srv.stop();
  }
}

/**
 * F1: @x402/fetch. Every other suite in this bench already runs on it, so this case exists to put
 * a dated line in the matrix next to the others rather than to discover anything.
 */
async function runFetchCase(cfg: BuyerConfig): Promise<CaseOutcome> {
  const { account } = loadOrCreateAccount(cfg);
  const ctx = createContext(cfg, account);
  const started = performance.now();
  const rec = await paidRequest(ctx, { route: "/paid/exact", suite: "F" as Suite, test: "F1", label: "fetch" });
  appendRecord(cfg, rec);
  return {
    ok: rec.finalStatus === 200,
    totalMs: round(performance.now() - started),
    detail: rec.finalStatus === 200 ? "content delivered" : `status ${rec.finalStatus ?? "none"}`,
    error: rec.error,
    transaction: rec.receipt?.transaction || undefined,
    transport: "HTTP headers (PAYMENT-REQUIRED / PAYMENT-SIGNATURE)",
  };
}

/**
 * F6: an MPP client against the unmodified x402 endpoint. The plan asks us to confirm the claim
 * that MPP is backward compatible with x402, so this pays through `mppx` — the Machine Payments
 * Protocol CLI — with `--protocol x402` and checks that our seller needed no change.
 *
 * The key goes in as an environment variable for this one child process and is never written to
 * an mppx config file. It is the same capped test wallet as the rest of the bench.
 */
async function runMppCase(cfg: BuyerConfig): Promise<CaseOutcome> {
  const { account } = loadOrCreateAccount(cfg);
  const url = `${cfg.sellerUrl}/paid/exact`;
  const started = performance.now();
  const { spawn } = await import("node:child_process");

  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    // --include prints the response headers, which is where the payment-response receipt lives.
    // Do not add --silent: it suppresses those headers, and then a successful payment looks like
    // a failure because the status line is missing from stdout.
    const child = spawn("npx", ["mppx", url, "--protocol", "x402", "--include"], {
      cwd: BUYER_DIR,
      env: { ...process.env, MPPX_PRIVATE_KEY: cfg.privateKey ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const totalMs = round(performance.now() - started);
  // The receipt rides back in the payment-response header, base64 like everywhere else in x402.
  const header = /payment-response:\s*([A-Za-z0-9+/=]+)/i.exec(out.stdout)?.[1];
  let transaction: string | undefined;
  if (header) {
    try {
      transaction = JSON.parse(Buffer.from(header, "base64").toString("utf8")).transaction;
    } catch {
      /* Leave it unset rather than guess; the status below still says whether it worked. */
    }
  }
  // Judge on the delivered body, not the status line: the body is the thing we paid for, and it
  // cannot appear unless the gate opened.
  const ok = out.stdout.includes('"bench":"x402-bench"');
  return {
    ok,
    totalMs,
    detail: ok
      ? "MPP client paid an unmodified x402 endpoint, content delivered"
      : `exit ${out.code}, no 200 in output`,
    error: ok ? undefined : (out.stderr || out.stdout).slice(0, 300),
    transaction,
    transport: "HTTP headers, x402 mode — MPP maps its charge intent onto x402 exact",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const requested = str(args, "case", "all");
  const selected: Case[] = requested === "all" ? [...CASES] : CASES.filter((c) => c === requested);
  if (selected.length === 0) throw new Error(`Unknown case "${requested}". Use ${CASES.join(", ")}, or all.`);

  const { account } = loadOrCreateAccount(cfg);
  console.log(`buyer=${account.address} network=${cfg.network} cases=${selected.join(",")}\n`);

  for (const c of selected) {
    const test = TEST_ID[c];
    console.log(`${test} ${c}`);
    const outcome = c === "mcp" ? await runMcpCase(cfg) : c === "mpp" ? await runMppCase(cfg) : await runFetchCase(cfg);
    console.log(`  transport: ${outcome.transport}`);
    console.log(
      `  result:    ${outcome.ok ? "WORKS" : "FAILS"} in ${outcome.totalMs} ms — ${outcome.detail}` +
        (outcome.transaction ? `  tx ${outcome.transaction.slice(0, 12)}…` : ""),
    );
    if (outcome.error) console.log(`  error:     ${outcome.error.slice(0, 300)}`);
    console.log();

    // F1 already appends its own record through paidRequest; only the MCP case needs one here.
    if (c !== "fetch") {
      const record: BuyerRecord = {
        kind: "buyer",
        v: 1,
        requestId: randomUUID(),
        suite: "F" as Suite,
        test,
        label: c === "mcp" ? "mcp-agents-sdk" : "mppx-cli",
        startedAt: new Date().toISOString(),
        url: c === "mcp" ? "mcp://in-process/premium_snack_info" : `${cfg.sellerUrl}/paid/exact`,
        path: c === "mcp" ? `/${TOOL_NAME}` : "/paid/exact",
        buyer: account.address,
        network: cfg.network,
        totalMs: outcome.totalMs,
        finalStatus: outcome.ok ? 200 : undefined,
        receipt: outcome.transaction
          ? { success: true, transaction: outcome.transaction, network: cfg.network, payer: account.address }
          : undefined,
        error: outcome.error,
        versions: packageVersions(),
      };
      appendRecord(cfg, record);
    }
  }
  console.log("records appended under results/. Run pnpm report for the Suite F matrix.");
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
