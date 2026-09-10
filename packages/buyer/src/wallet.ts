import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, type Chain, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import * as allChains from "viem/chains";
import { isMain } from "./cli.ts";
import { ENV_EXAMPLE_FILE, ENV_FILE, loadConfig, type BuyerConfig } from "./config.ts";

/** Canonical Permit2 address, identical on every EVM chain. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export function chainFor(chainId: number): Chain {
  const chain = (Object.values(allChains) as unknown[]).find(
    (c): c is Chain => typeof c === "object" && c !== null && (c as Chain).id === chainId,
  );
  if (!chain) throw new Error(`No viem chain definition for chain id ${chainId}.`);
  return chain;
}

export function publicClient(cfg: BuyerConfig): PublicClient {
  return createPublicClient({ chain: chainFor(cfg.chainId), transport: http(cfg.rpcUrl) });
}

/**
 * Load the buyer key from .env, or generate one and write it there.
 * The generated key is for testnet only and the balance must stay under 20 USD.
 */
export function loadOrCreateAccount(cfg: BuyerConfig): { account: PrivateKeyAccount; created: boolean } {
  if (cfg.privateKey) {
    return { account: privateKeyToAccount(cfg.privateKey), created: false };
  }
  const key = generatePrivateKey();
  const template = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8")
    : existsSync(ENV_EXAMPLE_FILE)
      ? readFileSync(ENV_EXAMPLE_FILE, "utf8")
      : "";
  const line = `BUYER_PRIVATE_KEY=${key}`;
  const next = /^BUYER_PRIVATE_KEY=.*$/m.test(template)
    ? template.replace(/^BUYER_PRIVATE_KEY=.*$/m, line)
    : `${template.trimEnd()}\n${line}\n`;
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  process.env.BUYER_PRIVATE_KEY = key;
  cfg.privateKey = key;
  return { account: privateKeyToAccount(key), created: true };
}

export interface Balances {
  eth: string;
  usdc: string;
  usdcAtomic: bigint;
  permit2Allowance: bigint;
}

export async function balances(cfg: BuyerConfig, address: `0x${string}`): Promise<Balances> {
  const client = publicClient(cfg);
  const [eth, usdcAtomic, permit2Allowance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: cfg.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    client.readContract({
      address: cfg.usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, PERMIT2_ADDRESS],
    }),
  ]);
  return { eth: formatEther(eth), usdc: formatUnits(usdcAtomic, 6), usdcAtomic, permit2Allowance };
}

export function fundingInstructions(cfg: BuyerConfig, address: string): string {
  const lines = [
    `Buyer address: ${address}`,
    `Network:       ${cfg.network} (chain ${cfg.chainId})`,
    "",
    "Fund it before running paid tests. Keep the total under 20 USD.",
    "  USDC (test):  https://faucet.circle.com  -> select Base Sepolia",
    "  ETH  (gas):   https://portal.cdp.coinbase.com/products/faucet  or  https://docs.base.org/base-chain/tools/network-faucets",
    "",
    "ETH is only needed once, for the Permit2 approval that the upto scheme requires:",
    "  pnpm permit2",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { account, created } = loadOrCreateAccount(cfg);
  if (created) {
    console.log(`Generated a new buyer key and wrote it to ${ENV_FILE} (mode 600). Never commit this file.\n`);
  }
  console.log(fundingInstructions(cfg, account.address));
  try {
    const b = await balances(cfg, account.address);
    console.log("");
    console.log(`ETH balance:        ${b.eth}`);
    console.log(`USDC balance:       ${b.usdc}`);
    console.log(`Permit2 allowance:  ${b.permit2Allowance > 0n ? "approved" : "not approved (run pnpm permit2 before Suite D)"}`);
  } catch (err) {
    console.log(`\nCould not read balances from ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
