import { pathToFileURL } from "node:url";

export type Args = Record<string, string | boolean>;

/** Minimal `--key value`, `--key=value`, `--flag` parser. */
export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function str(args: Args, key: string, fallback: string): string;
export function str(args: Args, key: string): string | undefined;
export function str(args: Args, key: string, fallback?: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

export function num(args: Args, key: string, fallback: number): number {
  const v = Number(args[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function bool(args: Args, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

/** Parse "30s", "5m", "1h", "48h", or plain seconds. */
export function parseDurationSeconds(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`Cannot parse duration "${value}". Use e.g. 30s, 5m, 1h, 48h.`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n / 1000;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86_400;
    default:
      return n;
  }
}

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === moduleUrl;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fmt(ms: number | undefined): string {
  return ms === undefined ? "-" : ms.toFixed(0).padStart(6);
}
