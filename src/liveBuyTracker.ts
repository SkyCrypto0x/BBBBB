import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import { appConfig, ChainId } from "./rpcAndApi";
import { groupSettings, BuyBotSettings } from "./feature.buyBot";
import fetch from "node-fetch";

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

interface PairRuntime {
  contract: ethers.Contract;
  token0: string;
  token1: string;
}

interface ChainRuntime {
  provider: ethers.providers.Provider;
  pairs: Map<string, PairRuntime>;
}

const runtimes = new Map<ChainId, ChainRuntime>();

export function startLiveBuyTracker(bot: Telegraf) {
  syncListeners(bot).catch((e) => console.error("Initial sync error:", e));
  setInterval(() => syncListeners(bot).catch((e) => console.error("Sync error:", e)), 15_000);
}

async function syncListeners(bot: Telegraf) {
  console.log("🔁 Syncing live listeners...");

  for (const [groupId, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

    let runtime = runtimes.get(chain);
    if (!runtime) {
      const provider = chainCfg.rpcUrl.startsWith("wss")
        ? new ethers.providers.WebSocketProvider(chainCfg.rpcUrl)
        : new ethers.providers.JsonRpcProvider(chainCfg.rpcUrl);

      runtime = { provider, pairs: new Map() };
      runtimes.set(chain, runtime);
      console.log(`🔗 Connected to ${chain} RPC`);
    }

    for (const pairAddr of settings.allPairAddresses) {
      const addr = pairAddr.toLowerCase();
      if (runtime.pairs.has(addr)) continue;

      try {
        const contract = new ethers.Contract(addr, PAIR_ABI, runtime.provider);
        const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);

        const t0 = token0.toLowerCase();
        const t1 = token1.toLowerCase();

        runtime.pairs.set(addr, { contract, token0: t0, token1: t1 });

        console.log(`🛰️ Listening on pair ${addr.substring(0, 10)}...`);

        contract.on("Swap", (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
          handleSwap(
            bot,
            chain,
            addr,
            { token0: t0, token1: t1 },
            event.transactionHash,
            amount0In,
            amount1In,
            amount0Out,
            amount1Out
          );
        });
      } catch (e) {
        console.error(`Failed to attach listener to pair ${addr}`, e);
      }
    }
  }
}

async function handleSwap(
  bot: Telegraf,
  chain: ChainId,
  pairAddress: string,
  tokens: { token0: string; token1: string },
  txHash: string,
  amount0In: ethers.BigNumber,
  amount1In: ethers.BigNumber,
  amount0Out: ethers.BigNumber,
  amount1Out: ethers.BigNumber
) {
  const relatedGroups: [number, BuyBotSettings][] = [];

  for (const [groupId, settings] of groupSettings.entries()) {
    if (settings.chain === chain && settings.allPairAddresses.some(p => p.toLowerCase() === pairAddress)) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (relatedGroups.length === 0) return;

  const settings = relatedGroups[0][1];
  const targetToken = settings.tokenAddress.toLowerCase();

  const isToken0 = tokens.token0 === targetToken;
  const isToken1 = tokens.token1 === targetToken;
  if (!isToken0 && !isToken1) return;

  const baseIn = isToken0 ? amount1In : amount0In;
  const tokenOut = isToken0 ? amount0Out : amount1Out;

  if (baseIn.lte(0) || tokenOut.lte(0)) return; // not a buy

  const baseAmount = parseFloat(ethers.utils.formatUnits(baseIn, 18));

  // Get real-time USD price from DexScreener
  let usdValue = baseAmount * (chain === "bsc" ? 600 : 3000); // fallback
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${settings.pairAddress}`);
    if (res.ok) {
      const data: any = await res.json();
      if (data?.pair?.priceUsd && data?.pair?.priceNative) {
        const nativePriceUsd = data.pair.priceUsd / parseFloat(data.pair.priceNative);
        usdValue = baseAmount * nativePriceUsd;
      }
    }
  } catch (e) {
    console.error("DexScreener price fetch failed, using fallback");
  }

  for (const [groupId, s] of relatedGroups) {
    sendPremiumBuyAlert(bot, groupId, s, usdValue, baseAmount, txHash, chain);
  }
}

async function sendPremiumBuyAlert(
  bot: Telegraf,
  groupId: number,
  settings: BuyBotSettings,
  usdValue: number,
  baseAmount: number,
  txHash: string,
  chain: ChainId
) {
  const buyUsd = Number(usdValue.toFixed(2));
  if (buyUsd < settings.minBuyUsd) return;
  if (settings.maxBuyUsd && buyUsd > settings.maxBuyUsd) return;

  const emojiCount = Math.min(30, Math.max(1, Math.floor(buyUsd / settings.dollarsPerEmoji)));
  const emojiBar = settings.emoji.repeat(emojiCount);

  const explorerUrl = `${appConfig.chains[chain].explorer}/tx/${txHash}`;
  const dexUrl = `https://dexscreener.com/${chain}/${settings.pairAddress}`;
  const baseSymbol = chain === "bsc" ? "BNB" : "ETH";

  const message = `
🚀 <b>BUY DETECTED!</b> 🚀

<b>$${buyUsd.toLocaleString("en-US")} BUY</b>
${emojiBar}

🪙 <b>Token:</b> <code>${shorten(settings.tokenAddress)}</code>
💰 <b>Amount:</b> ${baseAmount.toFixed(4)} ${baseSymbol}
🔗 <a href="${explorerUrl}">View Transaction</a>
📊 <a href="${dexUrl}">DexScreener Chart</a>
${settings.tgGroupLink ? `\n👥 <a href="${settings.tgGroupLink}">Join Community</a>` : ""}
  `.trim();

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔗 Transaction", url: explorerUrl }],
      [{ text: "📊 DexScreener", url: dexUrl }],
      settings.tgGroupLink ? [{ text: "👥 Join Community", url: settings.tgGroupLink }] : []
    ].filter(row => row.length > 0)
  };

  try {
    if (settings.animationFileId) {
      await bot.telegram.sendAnimation(groupId, settings.animationFileId, { caption: message, parse_mode: "HTML", reply_markup: keyboard } as any);
    } else if (settings.imageFileId) {
      await bot.telegram.sendPhoto(groupId, settings.imageFileId, { caption: message, parse_mode: "HTML", reply_markup: keyboard } as any);
    } else if (settings.imageUrl) {
      const isGif = settings.imageUrl.toLowerCase().endsWith(".gif");
      if (isGif) {
        await bot.telegram.sendAnimation(groupId, settings.imageUrl, { caption: message, parse_mode: "HTML", reply_markup: keyboard } as any);
      } else {
        await bot.telegram.sendPhoto(groupId, settings.imageUrl, { caption: message, parse_mode: "HTML", reply_markup: keyboard } as any);
      }
    } else {
      await bot.telegram.sendMessage(groupId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    }
    console.log(`✅ Alert sent → $${buyUsd} to group ${groupId}`);
  } catch (err: any) {
    console.error(`Send failed to ${groupId}:`, err.message);
  }
}

function shorten(addr: string, len = 6): string {
  return addr ? `${addr.slice(0, len)}...${addr.slice(-len + 2)}` : "";
}