/**
 * Read every Base-mainnet settlement in results/*.jsonl back from the chain and write
 * results/mainnet-gas.json: gas used, L2 + L1 fee, who paid the gas, and where the USDC went.
 * Receipts are cached by hash so re-runs only fetch new settlements.
 *
 *   pnpm gas
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { base } from "viem/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const resultsDir = path.join(root, "results");
const outFile = path.join(resultsDir, "mainnet-gas.json");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface GasRow {
  test: string;
  requestId: string;
  startedAt: string;
  tx: string;
  status: "success" | "reverted";
  block: number;
  gasUsed: number;
  effectiveGasPriceGwei: number;
  l2FeeEth: number;
  l1FeeEth: number;
  totalFeeEth: number;
  gasPayer: string;
  transfers: { from: string; to: string; usdc: string }[];
}
export interface GasFile {
  fetchedAt: string;
  ethUsd: number | null;
  rows: GasRow[];
}

const prev: GasFile = existsSync(outFile)
  ? (JSON.parse(readFileSync(outFile, "utf8")) as GasFile)
  : { fetchedAt: "", ethUsd: null, rows: [] };
const known = new Map(prev.rows.map((r) => [r.tx, r]));

const wanted: { test: string; requestId: string; startedAt: string; tx: string }[] = [];
for (const file of readdirSync(resultsDir).filter((f) => f.startsWith("buyer-") && f.endsWith(".jsonl"))) {
  for (const line of readFileSync(path.join(resultsDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { test?: string; requestId: string; startedAt: string; network?: string; receipt?: { transaction?: string } };
    const tx = r.receipt?.transaction;
    if (r.network === "eip155:8453" && tx && !known.has(tx)) wanted.push({ test: r.test ?? "?", requestId: r.requestId, startedAt: r.startedAt, tx });
  }
}

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL_MAINNET ?? "https://mainnet.base.org") });
for (const w of wanted) {
  const receipt = await client.getTransactionReceipt({ hash: w.tx as `0x${string}` });
  const tx = await client.getTransaction({ hash: w.tx as `0x${string}` });
  const l2 = receipt.gasUsed * receipt.effectiveGasPrice;
  const l1 = (receipt as { l1Fee?: bigint }).l1Fee ?? 0n;
  known.set(w.tx, {
    ...w,
    status: receipt.status,
    block: Number(receipt.blockNumber),
    gasUsed: Number(receipt.gasUsed),
    effectiveGasPriceGwei: Number(formatUnits(receipt.effectiveGasPrice, 9)),
    l2FeeEth: Number(formatEther(l2)),
    l1FeeEth: Number(formatEther(l1)),
    totalFeeEth: Number(formatEther(l2 + l1)),
    gasPayer: tx.from,
    transfers: receipt.logs
      .filter((l) => l.address.toLowerCase() === USDC && l.topics[0] === TRANSFER)
      .map((l) => ({
        from: `0x${(l.topics[1] ?? "").slice(26)}`,
        to: `0x${(l.topics[2] ?? "").slice(26)}`,
        usdc: formatUnits(BigInt(l.data), 6),
      })),
  });
  console.log(`${w.test} ${w.tx.slice(0, 12)}… ${receipt.status} gas=${receipt.gasUsed} payer=${tx.from.slice(0, 10)}…`);
}

let ethUsd: number | null = prev.ethUsd;
try {
  const j = (await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot")).json()) as { data: { amount: string } };
  ethUsd = Number(j.data.amount);
} catch {
  /* keep the previous price */
}

const out: GasFile = { fetchedAt: new Date().toISOString(), ethUsd, rows: [...known.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`${wanted.length} new receipts, ${out.rows.length} total → ${outFile} (ETH/USD ${ethUsd})`);
