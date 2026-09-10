import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUYER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(BUYER_DIR, "../..");
export const ENV_FILE = path.join(REPO_ROOT, ".env");
export const ENV_EXAMPLE_FILE = path.join(REPO_ROOT, ".env.example");

loadDotenv({ path: ENV_FILE, quiet: true });

export interface BuyerConfig {
  sellerUrl: string;
  privateKey?: `0x${string}`;
  /** CAIP-2 network id. */
  network: string;
  chainId: number;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  resultsDir: string;
}

export function loadConfig(): BuyerConfig {
  const network = process.env.NETWORK?.trim() || "eip155:84532";
  const chainId = chainIdFromCaip2(network);
  const key = process.env.BUYER_PRIVATE_KEY?.trim();
  const resultsDir = path.resolve(REPO_ROOT, process.env.RESULTS_DIR?.trim() || "results");
  mkdirSync(resultsDir, { recursive: true });
  return {
    sellerUrl: (process.env.SELLER_URL?.trim() || "http://localhost:8787").replace(/\/$/, ""),
    privateKey: key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : undefined,
    network,
    chainId,
    rpcUrl: process.env.RPC_URL?.trim() || "https://sepolia.base.org",
    usdcAddress: (process.env.USDC_ADDRESS?.trim() || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
    resultsDir,
  };
}

export function chainIdFromCaip2(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`Only EVM networks (eip155:<chainId>) are supported by the buyer. Got "${network}".`);
  return Number(match[1]);
}

/** Versions of the x402 packages in use, recorded with every result. */
export function packageVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["@x402/fetch", "@x402/core", "@x402/evm", "@x402/extensions", "viem"]) {
    const file = path.join(BUYER_DIR, "node_modules", name, "package.json");
    if (!existsSync(file)) continue;
    try {
      out[name] = (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
    } catch {
      // ignore
    }
  }
  out.node = process.version;
  return out;
}
