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

// 🔍 DexScreener: token address → best pair address
// Docs: https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}
export async function resolvePairFromToken(
  chain: ChainId,
  tokenAddress: string
): Promise<string | null> {
  try {
    const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("DexScreener error status:", res.status);
      return null;
    }
    const data: any = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    // highest liquidity pair = main pair
    let best = data[0];
    for (const p of data) {
      const bestLiq = Number(best?.liquidity?.usd ?? 0);
      const curLiq = Number(p?.liquidity?.usd ?? 0);
      if (curLiq > bestLiq) best = p;
    }

    return best.pairAddress ?? null;
  } catch (e) {
    console.error("resolvePairFromToken error:", e);
    return null;
  }
}
