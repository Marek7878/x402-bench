import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BuyerRecord } from "@x402-bench/shared";
import type { BuyerConfig } from "./config.ts";

/** Append one buyer record to results/buyer-YYYY-MM-DD.jsonl. */
export function appendRecord(cfg: BuyerConfig, record: BuyerRecord): string {
  mkdirSync(cfg.resultsDir, { recursive: true });
  const day = record.startedAt.slice(0, 10);
  const file = path.join(cfg.resultsDir, `buyer-${day}.jsonl`);
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

export function pendingDir(cfg: BuyerConfig): string {
  const dir = path.join(cfg.resultsDir, "pending");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function settledDir(cfg: BuyerConfig): string {
  const dir = path.join(cfg.resultsDir, "settled");
  mkdirSync(dir, { recursive: true });
  return dir;
}
