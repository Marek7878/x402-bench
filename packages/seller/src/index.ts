import { Hono, type MiddlewareHandler } from "hono";
import { paymentMiddleware, setSettlementOverrides } from "@x402/hono";
import { FAULT_HEADER } from "@x402-bench/shared";
import { flag, requireEnv, type Env } from "./env.ts";
import { buildResourceServer } from "./payment.ts";
import { benchRecorder } from "./recorder.ts";
import { buildRoutes } from "./routes.ts";

/** Every route returns exactly this many bytes of JSON so payload size is a constant. */
const PAYLOAD_BYTES = 1024;

function fixedPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { bench: "x402-bench", bytes: PAYLOAD_BYTES, ...extra, pad: "" };
  const padLength = Math.max(0, PAYLOAD_BYTES - JSON.stringify(body).length);
  body.pad = "x".repeat(padLength);
  return body;
}

type AppEnv = { Bindings: Env };

function buildApp(env: Env): Hono<AppEnv> {
  requireEnv(env);
  const faultsEnabled = flag(env.BENCH_FAULTS_ENABLED, false);
  const routes = buildRoutes(env);
  const server = buildResourceServer(env);

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    console.error(JSON.stringify({ kind: "seller-error", path: c.req.path, error: err.message }));
    return c.json({ error: err.message }, 500);
  });

  // Outermost: request id, whole-request timing, Server-Timing header, JSON log line.
  app.use("*", benchRecorder({ facilitatorUrl: env.FACILITATOR_URL, network: env.NETWORK, faultsEnabled }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      network: env.NETWORK,
      facilitator: env.FACILITATOR_URL,
      faultsEnabled,
      routes: Object.keys(routes),
    }),
  );

  // Facilitator reachability from this Worker (useful per colo for A5 and B).
  app.get("/health/facilitator", async (c) => {
    const url = `${env.FACILITATOR_URL.replace(/\/$/, "")}/supported`;
    const t0 = performance.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { kinds?: unknown[] };
      return c.json({ ok: res.ok, url, status: res.status, ms: Math.round(performance.now() - t0), kinds: body.kinds?.length });
    } catch (err) {
      return c.json({ ok: false, url, ms: Math.round(performance.now() - t0), error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 502);
    }
  });

  // Suite A1 baseline: same payload, no payment gate.
  app.get("/free", (c) => c.json(fixedPayload({ route: "free" })));

  // Payment gate for everything under /paid.
  //
  // Constructed lazily inside the first paid request, not at app build time. @x402/hono starts the
  // facilitator /supported call the moment paymentMiddleware() is called, and Workers cancel I/O
  // that was started in one request when a later request awaits it. If the middleware were built
  // during, say, a /health request, every following /paid request would hang on that dead promise.
  let paymentGate: MiddlewareHandler | undefined;
  app.use("/paid/*", async (c, next) => {
    paymentGate ??= paymentMiddleware(routes, server, undefined, undefined, flag(env.SYNC_FACILITATOR_ON_START, true));
    return paymentGate(c, next);
  });

  // Suite E8 via header: fail the handler after a successful verify on any paid route.
  app.use("/paid/*", async (c, next) => {
    if (faultsEnabled && c.req.header(FAULT_HEADER) === "handler-500") {
      return c.json({ error: "injected handler failure", route: c.req.path }, 500);
    }
    await next();
  });

  app.get("/paid/exact", (c) => c.json(fixedPayload({ route: "exact" })));

  app.get("/paid/upto", (c) => {
    // ?charge= accepts atomic units ("4000"), a percentage ("40%"), or dollars ("$0.004").
    // Omit it to settle the full authorized maximum.
    const charge = c.req.query("charge");
    if (charge) setSettlementOverrides(c, { amount: charge });
    return c.json(fixedPayload({ route: "upto", charge: charge ?? "max" }));
  });

  app.get("/paid/exact-id", (c) => c.json(fixedPayload({ route: "exact-id" })));

  app.get("/paid/fail500", (c) => c.json({ error: "injected handler failure", route: "fail500" }, 500));

  app.get("/paid/slow", async (c) => {
    const requested = Number(c.req.query("ms") ?? 2000);
    const ms = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 2000, 25_000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return c.json(fixedPayload({ route: "slow", sleptMs: ms }));
  });

  return app;
}

/** One app per Env object; workerd reuses the same Env across requests in an isolate. */
const apps = new WeakMap<Env, Hono<AppEnv>>();

export default {
  fetch(request, env, ctx) {
    let app = apps.get(env);
    if (!app) {
      try {
        app = buildApp(env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
