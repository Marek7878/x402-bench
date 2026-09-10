/**
 * One-time Permit2 approval for the buyer wallet. Required by the upto scheme.
 * Costs gas: the wallet needs a little base-sepolia ETH.
 *
 *   pnpm permit2            # approve if not already approved
 *   pnpm permit2 --check    # only report the current allowance
 */
import { createWalletClient, http } from "viem";
import { createPermit2ApprovalTx } from "@x402/evm/upto/client";
import { bool, isMain, parseArgs } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { balances, chainFor, loadOrCreateAccount, publicClient } from "./wallet.ts";

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const { account } = loadOrCreateAccount(cfg);
  const b = await balances(cfg, account.address);

  console.log(`buyer ${account.address} on ${cfg.network}`);
  console.log(`  ETH ${b.eth}  USDC ${b.usdc}  Permit2 allowance ${b.permit2Allowance.toString()}`);

  if (b.permit2Allowance > 0n) {
    console.log("Permit2 already approved. Nothing to do.");
    return;
  }
  if (bool(args, "check")) {
    console.log("Permit2 not approved. Run `pnpm permit2` to approve.");
    return;
  }
  if (b.eth === "0") {
    throw new Error("No ETH for gas. Fund the wallet with a small amount of base-sepolia ETH first (see pnpm wallet).");
  }

  const tx = createPermit2ApprovalTx(cfg.usdcAddress);
  const wallet = createWalletClient({ account, chain: chainFor(cfg.chainId), transport: http(cfg.rpcUrl) });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
  console.log(`approval sent: ${hash}`);
  const receipt = await publicClient(cfg).waitForTransactionReceipt({ hash });
  console.log(`  status=${receipt.status} gasUsed=${receipt.gasUsed.toString()} effectiveGasPrice=${receipt.effectiveGasPrice.toString()} wei`);
  console.log(`  gas cost ≈ ${(Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18).toFixed(8)} ETH`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
