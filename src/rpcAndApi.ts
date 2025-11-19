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

// 🔍 Get *all* pools for a token on a chain
// API: GET https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}

// Ei function ta pura replace kor
export async function fetchTokenPairs(chain: ChainId, tokenAddress: string): Promise<DexPair[]> {
  try {
    // NEW WORKING API (2025)
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.pairs || !Array.isArray(data.pairs)) return [];

    return data.pairs
      .filter((p: any) => p.chainId === chain)
      .map((p: any) => ({
        chainId: p.chainId,
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        liquidity: { usd: p.liquidity?.usd },
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