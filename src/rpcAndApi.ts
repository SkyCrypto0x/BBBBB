import { readFileSync } from "fs";
import path from "path";
import fetch from "node-fetch";

export type ChainId = string;

export interface ChainConfig {
  rpcUrl: string;
  explorer: string;
}

export interface AppConfig {
  telegramBotToken: string;
  botUsername: string;
  defaultChain: ChainId;
  chains: Record<ChainId, ChainConfig>;
}

export const appConfig: AppConfig = JSON.parse(
  readFileSync(path.join(__dirname, "..", "config.json"), "utf8")
);

// 🔹 DexScreener pair type (simplified)
export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  liquidity?: {
    usd?: number;
  };
}

// 🔎 Normalize DexScreener chain variants (eth / chain.id / chainName / etc)
function normalizeDexChain(raw: any): string | undefined {
  if (!raw) return undefined;
  let c = String(raw).toLowerCase();
  if (c === "eth") c = "ethereum";
  if (c === "bnb" || c === "bsc") c = "bsc";
  if (c === "arb") c = "arbitrum";
  if (c === "matic") c = "polygon";
  if (c === "avax") c = "avalanche";
  return c;
}

// 🔍 Get *all* pools for a token on a chain
// First try latest/dex/tokens, then fallback to latest/dex/search
export async function fetchTokenPairs(
  chain: ChainId,
  tokenAddress: string
): Promise<DexPair[]> {
  const addr = tokenAddress.toLowerCase();

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
    let res = await fetch(url);
    let data: any = await res.json();

    let pairs: any[] = Array.isArray(data.pairs) ? data.pairs : [];

    // tokens endpoint e jodi na paoa jay, search diye fallback
    if (!pairs.length) {
      const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${addr}`;
      const searchRes = await fetch(searchUrl);
      const searchData: any = await searchRes.json();
      if (Array.isArray(searchData.pairs)) {
        pairs = searchData.pairs;
      }
    }

    if (!pairs.length) return [];

    return pairs
      .filter(
        (p: any) =>
          normalizeDexChain(
            p.chainId ?? p.chain?.id ?? p.chainName ?? p.chain?.name
          ) === chain
      )
      .filter((p: any) => p.liquidity?.usd && p.liquidity.usd > 0)
      .map((p: any) => ({
        chainId:
          (normalizeDexChain(
            p.chainId ?? p.chain?.id ?? p.chainName ?? p.chain?.name
          ) as string) ?? "",
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        url: p.url,
        liquidity: { usd: p.liquidity?.usd }
      }));
  } catch (e) {
    console.error("DexScreener fetch error:", e);
    return [];
  }
}

// ✅ Backwards-compatible helper: return the best (highest liq) pair address
export async function resolvePairFromToken(
  chain: ChainId,
  tokenAddress: string
): Promise<string | null> {
  const pairs = await fetchTokenPairs(chain, tokenAddress);
  if (!pairs.length) return null;

  let best = pairs[0];
  for (const p of pairs) {
    const bestLiq = Number(best?.liquidity?.usd ?? 0);
    const curLiq = Number(p?.liquidity?.usd ?? 0);
    if (curLiq > bestLiq) best = p;
  }
  return best.pairAddress ?? null;
}
