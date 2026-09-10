/**
 * Compare what each facilitator supports. Feeds Suite G (networks and scheme support per
 * network) and explains criterion B: the public facilitator and CDP are not the same service.
 *
 *   pnpm facilitators
 *
 * CDP columns need CDP_API_KEY_ID and CDP_API_KEY_SECRET in .dev.vars. The credentials are read
 * but never printed. Runs from this package because @coinbase/x402 is a dependency of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { createCdpAuthHeaders } from "@coinbase/x402";

const PUBLIC_URL = "https://x402.org/facilitator";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/** Names for the chain ids we care about, so the matrix reads without a lookup. */
const NETWORK_NAMES = {
  "eip155:8453": "Base mainnet",
  "eip155:84532": "Base Sepolia",
  "eip155:137": "Polygon",
  "eip155:42161": "Arbitrum One",
  "eip155:480": "World Chain",
  "eip155:4801": "World Chain Sepolia",
  "eip155:1": "Ethereum mainnet",
  "eip155:11155111": "Ethereum Sepolia",
};

function credsFromDevVars() {
  if (!existsSync("./.dev.vars")) return {};
  const txt = readFileSync("./.dev.vars", "utf8");
  const get = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1]?.trim();
  return { id: get("CDP_API_KEY_ID"), secret: get("CDP_API_KEY_SECRET") };
}

async function kindsOf(label, url, headers) {
  const started = performance.now();
  try {
    const res = await fetch(`${url}/supported`, headers ? { headers } : undefined);
    const ms = Math.round(performance.now() - started);
    if (!res.ok) {
      console.log(`${label}: HTTP ${res.status} after ${ms} ms — ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const body = await res.json();
    const kinds = body.kinds ?? body;
    console.log(`${label}: ${kinds.length} kinds in ${ms} ms`);
    return kinds;
  } catch (err) {
    console.log(`${label}: unreachable — ${err?.message ?? err}`);
    return null;
  }
}

const schemesByNetwork = (kinds) => {
  const out = new Map();
  for (const k of kinds ?? []) {
    out.set(k.network, new Set([...(out.get(k.network) ?? []), k.scheme]));
  }
  return out;
};

const { id, secret } = credsFromDevVars();
const pub = await kindsOf("public  x402.org/facilitator", PUBLIC_URL);
let cdp = null;
if (id && secret) {
  const headers = await createCdpAuthHeaders(id, secret)();
  cdp = await kindsOf("CDP     api.cdp.coinbase.com", CDP_URL, headers.supported);
} else {
  console.log("CDP: skipped, no CDP_API_KEY_ID / CDP_API_KEY_SECRET in .dev.vars");
}

const p = schemesByNetwork(pub);
const c = schemesByNetwork(cdp);
const networks = [...new Set([...p.keys(), ...c.keys()])].sort();
const fmt = (set) => (set ? [...set].sort().join(", ") : "—");

console.log("\n| network | name | public facilitator | CDP facilitator |");
console.log("|---|---|---|---|");
for (const n of networks) {
  console.log(`| \`${n}\` | ${NETWORK_NAMES[n] ?? ""} | ${fmt(p.get(n))} | ${fmt(c.get(n))} |`);
}

const onlyCdp = networks.filter((n) => c.has(n) && !p.has(n));
console.log(`\nNetworks CDP adds over the public facilitator: ${onlyCdp.length ? onlyCdp.join(", ") : "none"}`);
console.log(
  p.has("eip155:8453") || c.has("eip155:8453")
    ? "Base mainnet is available" + (c.has("eip155:8453") && !p.has("eip155:8453") ? " on CDP only." : ".")
    : "Base mainnet is not available on either.",
);
