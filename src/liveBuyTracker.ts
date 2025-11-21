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

interface PremiumAlertData {
  usdValue: number;
  baseAmount: number;
  tokenAmount: number;
  tokenSymbol: string;
  txHash: string;
  chain: ChainId;
  buyer: string;
  positionIncrease: number | null;
  marketCap: number;
  volume24h: number;
  priceUsd: number;
  pairAddress: string;
  pairLiquidityUsd: number;
}

export function startLiveBuyTracker(bot: Telegraf) {
  syncListeners(bot).catch((e) => console.error("Initial sync error:", e));
  setInterval(
    () => syncListeners(bot).catch((e) => console.error("Sync error:", e)),
    15_000
  );
}

async function syncListeners(bot: Telegraf) {
  console.log("🔁 Syncing live listeners...");

  for (const [groupId, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

    // settings.allPairAddresses empty হলে auto-fill কর
    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
      if (validPairs.length > 0) {
        settings.allPairAddresses = validPairs.map((p) => p.address);
        console.log(
          `Auto-added ${validPairs.length} pools for ${settings.tokenAddress}`
        );
      }
    }

    let runtime = runtimes.get(chain);
    if (!runtime) {
      const provider = chainCfg.rpcUrl.startsWith("wss")
        ? new ethers.providers.WebSocketProvider(chainCfg.rpcUrl)
        : new ethers.providers.JsonRpcProvider(chainCfg.rpcUrl);

      runtime = { provider, pairs: new Map() };
      runtimes.set(chain, runtime);
      console.log(`🔗 Connected to ${chain} RPC`);
    }

    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      // still nothing → skip this group
      continue;
    }

    for (const pairAddr of settings.allPairAddresses) {
      const addr = pairAddr.toLowerCase();

      // Pair address check — shudhu real DEX pair e listener lagbe
      const isValidPair =
        addr === settings.pairAddress.toLowerCase() ||
        settings.allPairAddresses.map((a) => a.toLowerCase()).includes(addr);

      if (!isValidPair) {
        console.log(`Skipping unrelated pair ${addr} for group ${groupId}`);
        continue;
      }

      if (runtime.pairs.has(addr)) continue;

      try {
        const contract = new ethers.Contract(addr, PAIR_ABI, runtime.provider);

        // token0/token1 call er age try-catch (improved logging + Ethereum retry)
        let token0: string;
        let token1: string;

        try {
          [token0, token1] = await Promise.all([
            contract.token0(),
            contract.token1()
          ]);
        } catch (e: any) {
          console.log(
            `❌ Skipping non-standard pair ${addr} on ${chain}: ${
              e?.message || e
            }`
          );

          // Optional: Ethereum e ekbar retry (rate limit / transient RPC error handle করার জন্য)
          if (chain === "ethereum") {
            console.log(`🔄 Retrying token0/token1 for ${addr}...`);
            try {
              const retryToken0 = await contract.token0().catch(() => null);
              const retryToken1 = await contract.token1().catch(() => null);

              if (retryToken0 && retryToken1) {
                [token0, token1] = [retryToken0, retryToken1];
                console.log(`✅ Retry success for ${addr}`);
              } else {
                console.log(
                  `❌ Retry still missing token0/token1 for ${addr} (token0=${retryToken0}, token1=${retryToken1})`
                );
                continue;
              }
            } catch (retryErr: any) {
              console.log(
                `❌ Retry failed for ${addr}: ${
                  retryErr?.message || retryErr
                }`
              );
              continue;
            }
          } else {
            // onno chain-e eibar skip kore dao
            continue;
          }
        }

        const t0 = token0.toLowerCase();
        const t1 = token1.toLowerCase();

        runtime!.pairs.set(addr, { contract, token0: t0, token1: t1 });

        console.log(`🛰️ Listening on pair ${addr.substring(0, 10)}...`);

        contract.on(
          "Swap",
          (
            sender,
            amount0In,
            amount1In,
            amount0Out,
            amount1Out,
            to,
            event
          ) => {
            handleSwap(
              bot,
              chain,
              addr, // already lowercase
              { token0: t0, token1: t1 },
              event.transactionHash,
              amount0In,
              amount1In,
              amount0Out,
              amount1Out,
              to,
              event.blockNumber
            );
          }
        );
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
  amount1Out: ethers.BigNumber,
  to: string,
  blockNumber: number
) {
  const relatedGroups: [number, BuyBotSettings][] = [];

  for (const [groupId, settings] of groupSettings.entries()) {
    if (
      settings.chain === chain &&
      settings.allPairAddresses?.some(
        (p) => p.toLowerCase() === pairAddress.toLowerCase()
      )
    ) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (relatedGroups.length === 0) return;

  const settings = relatedGroups[0][1];

  // groupSettings er moddhe allPairAddresses already ache? na thakle fetch kore fill kor
  if (!settings.allPairAddresses || settings.allPairAddresses.length <= 1) {
    const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
    if (validPairs.length > 0) {
      settings.allPairAddresses = validPairs.map((p) => p.address);
      console.log(
        `🔎 Auto-filled ${validPairs.length} pools from DexScreener for ${settings.tokenAddress}`
      );
    }
  }

  const targetToken = settings.tokenAddress.toLowerCase();

  const isToken0 = tokens.token0 === targetToken;
  const isToken1 = tokens.token1 === targetToken;
  if (!isToken0 && !isToken1) return;

  const baseIn = isToken0 ? amount1In : amount0In;
  const tokenOut = isToken0 ? amount0Out : amount1Out;

  if (baseIn.lte(0) || tokenOut.lte(0)) return; // not a buy

  const baseAmount = parseFloat(ethers.utils.formatUnits(baseIn, 18));

  // ---- Real 24h Volume + MC + Price (pair-specific) ----
  let priceUsd = 0;
  let marketCap = 0;
  let volume24h = 0;
  let tokenSymbol = "TOKEN";
  let tokenDecimals = 18;
  let pairLiquidityUsd = 0;

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`
    );
    const data: any = await res.json();

    if (data?.pair) {
      const p = data.pair;

      if (
        p.baseToken?.address.toLowerCase() ===
        settings.tokenAddress.toLowerCase()
      ) {
        priceUsd = parseFloat(p.priceUsd || "0");
        tokenSymbol = p.baseToken.symbol || "TOKEN";
        tokenDecimals = p.baseToken.decimals || 18;
      } else if (
        p.quoteToken?.address.toLowerCase() ===
        settings.tokenAddress.toLowerCase()
      ) {
        const raw = parseFloat(p.priceUsd || "0");
        priceUsd = raw ? 1 / raw : 0;
        tokenSymbol = p.quoteToken.symbol || "TOKEN";
        tokenDecimals = p.quoteToken.decimals || 18;
      }

      marketCap = p.fdv || 0;
      volume24h = p.volume?.h24 || 0;
      pairLiquidityUsd = p.liquidity?.usd || 0;
    }
  } catch (e) {
    console.error("DexScreener fetch failed:", e);
  }

  if (marketCap === 0 && priceUsd > 0) {
    const totalSupply = 1_000_000_000_000_000;
    marketCap = priceUsd * totalSupply;
  }

  const nativePriceUsd = await getNativePrice(chain);

  const usdValue = baseAmount * nativePriceUsd;

  const tokenAmount = parseFloat(
    ethers.utils.formatUnits(tokenOut, tokenDecimals)
  );

  const buyer = ethers.utils.getAddress(to);
  const prevBalance = await getPreviousBalance(
    chain,
    settings.tokenAddress,
    buyer,
    blockNumber - 1
  );
  const currentBalance = prevBalance + tokenOut.toBigInt();

  let positionIncrease: number | null = null;
  if (prevBalance > 0n) {
    const diff = currentBalance - prevBalance;
    const increase = Number((diff * 1000n) / prevBalance) / 10;
    positionIncrease = Math.round(increase);
  }

  for (const [groupId, s] of relatedGroups) {
    const alertData: PremiumAlertData = {
      usdValue,
      baseAmount,
      tokenAmount,
      tokenSymbol,
      txHash,
      chain,
      buyer,
      positionIncrease,
      marketCap,
      volume24h,
      priceUsd,
      pairAddress,
      pairLiquidityUsd
    };

    await sendPremiumBuyAlert(bot, groupId, s, alertData);
  }
}

async function sendPremiumBuyAlert(
  bot: Telegraf,
  groupId: number,
  settings: BuyBotSettings,
  data: PremiumAlertData
) {
  const {
    usdValue,
    baseAmount,
    tokenAmount,
    tokenSymbol,
    txHash,
    chain,
    buyer,
    positionIncrease,
    marketCap,
    volume24h,
    pairAddress,
    pairLiquidityUsd
  } = data;

  const buyUsd = Math.round(usdValue);
  if (buyUsd < settings.minBuyUsd) return;
  if (settings.maxBuyUsd && buyUsd > settings.maxBuyUsd) return;

  const chainStr = String(chain).toLowerCase();

  // Chain অনুযায়ী emoji + symbol
  let baseEmoji = "";
  let baseSymbolText = "";

  if (chainStr === "bsc") {
    baseEmoji = "🟡";
    baseSymbolText = "BNB";
  } else if (
    chainStr === "ethereum" ||
    chainStr === "eth" ||
    chainStr === "mainnet"
  ) {
    baseEmoji = "🔹";
    baseSymbolText = "ETH";
  } else if (chainStr === "base") {
    baseEmoji = "🟦";
    baseSymbolText = "ETH";
  } else if (chainStr === "arbitrum" || chainStr === "arb") {
    baseEmoji = "🌀";
    baseSymbolText = "ETH";
  } else if (chainStr === "solana" || chainStr === "sol") {
    baseEmoji = "🟢";
    baseSymbolText = "SOL";
  } else if (chainStr === "polygon" || chainStr === "matic") {
    baseEmoji = "🟣";
    baseSymbolText = "MATIC";
  } else {
    baseEmoji = "💠";
    baseSymbolText = "NATIVE";
  }

  const explorerBase =
    appConfig.chains[chain]?.explorer ||
    (chainStr === "bsc"
      ? "https://bscscan.com"
      : "https://etherscan.io");

  const txUrl = `${explorerBase}/tx/${txHash}`;
  const addrUrl = `${explorerBase}/address/${buyer}`;
  const pairLink = `${explorerBase}/address/${pairAddress}`;

  // Emoji bar (no count text – শুধু bar)
  const emojiCount = Math.floor(
    buyUsd / (settings.dollarsPerEmoji || 50)
  );
  const emojiBar = settings.emoji.repeat(Math.min(50, emojiCount));

  const mcText = marketCap > 0 ? (marketCap / 1_000_000).toFixed(2) : "0.00";

  // Main pair এর LP নিয়ে নে (সবচেয়ে বেশি liquidity)
  let mainPairLp = pairLiquidityUsd;
  try {
    if (settings.allPairAddresses && settings.allPairAddresses.length > 0) {
      const mainPairs = await getAllValidPairs(settings.tokenAddress, chain);
      if (mainPairs.length > 0) {
        mainPairLp = mainPairs[0].liquidityUsd;
      }
    }
  } catch {
    // ignore — fallback pairLiquidityUsd
  }

  const lpText =
    mainPairLp > 0 ? (mainPairLp / 1_000_000).toFixed(2) : "0.00";

  const whaleLoadLine =
    positionIncrease !== null && positionIncrease > 500
      ? "🚀 <b>WHALE LOADING HEAVILY!</b>\n"
      : "";

  const volumeLine = `🔥 Volume (24h): $${volume24h >= 1_000_000
    ? (volume24h / 1_000_000).toFixed(1) + "M"
    : (volume24h / 1_000).toFixed(0) + "K"}`;

  const headerLine =
    buyUsd >= 5000
      ? "🐳🐳🐳 <b>WHALE INCOMING!!!</b> 🐳🐳🐳"
      : buyUsd >= 3000
      ? "🚨🚨🚨 <b>BIG BUY DETECTED!</b> 🚨🚨🚨"
      : buyUsd >= 1000
      ? "🟢🟢🟢 <b>Strong Buy</b> 🟢🟢🟢"
      : "🟢 <b>New Buy</b> 🟢";

  const message = `
${headerLine}
${whaleLoadLine}
💰 <b>$${buyUsd.toLocaleString()}</b> ${tokenSymbol} BUY
${emojiBar}

${baseEmoji} <b>${baseSymbolText}:</b> ${baseAmount.toFixed(
    4
  )} ($${buyUsd.toLocaleString()})
💳 ${tokenSymbol}: ${Math.round(tokenAmount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}

🔗 Pair: <a href="${pairLink}">${shorten(pairAddress, 10)}</a> → $${lpText}M LP

👤 Buyer: <a href="${addrUrl}">${shorten(buyer)}</a>
🔶 <a href="${txUrl}">View Transaction</a>
${
  positionIncrease !== null
    ? `🧠 <b>Position Increased: +${positionIncrease.toFixed(0)}%</b>\n`
    : ""
}📊 MC: $${mcText}M
${volumeLine}
  `.trim();

  const dexScreenerUrl = `https://dexscreener.com/${chain}/${settings.pairAddress}`;
  const dexToolsUrl = `https://www.dextools.io/app/${
    chainStr === "bsc" ? "bsc" : "ether"
  }/pair-explorer/${settings.pairAddress}`;

  const keyboard: any = {
    inline_keyboard: [
      [
        { text: "🦅 DexScreener", url: dexScreenerUrl },
        { text: "📈 DexTools", url: dexToolsUrl }
      ],
      settings.tgGroupLink
        ? [{ text: "👥 Join Alpha Group", url: settings.tgGroupLink }]
        : [],
      [
        {
          text: "✉️ DM for Access",
          url: "https://t.me/yourusername" // নিজের username বসাও
        }
      ]
    ].filter((row: any[]) => row.length > 0)
  };

  try {
    if (settings.animationFileId) {
      await bot.telegram.sendAnimation(groupId, settings.animationFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageFileId) {
      await bot.telegram.sendPhoto(groupId, settings.imageFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageUrl) {
      const isGif = settings.imageUrl.toLowerCase().endsWith(".gif");
      if (isGif) {
        await bot.telegram.sendAnimation(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
      } else {
        await bot.telegram.sendPhoto(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
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
  if (!addr) return "";
  return `${addr.slice(0, len)}...${addr.slice(-len + 2)}`;
}

/* ========= Extra helpers ========= */

// DexScreener theke sob valid pair + LP fetch
async function getAllValidPairs(
  tokenAddress: string,
  chain: ChainId
): Promise<Array<{ address: string; liquidityUsd: number }>> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );
    const data: any = await res.json();

    if (!data.pairs || data.pairs.length === 0) return [];

    return data.pairs
      .filter(
        (p: any) =>
          // MUST: chain match kora – na hole onnano chain er pools mix hoye jay
          p.chainId === chain &&
          (
            p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase() ||
            p.quoteToken.address.toLowerCase() === tokenAddress.toLowerCase()
          )
      )
      .filter((p: any) => p.liquidity?.usd > 1000)
      .map((p: any) => ({
        address: p.pairAddress,
        liquidityUsd: p.liquidity?.usd || 0
      }))
      .sort((a: any, b: any) => b.liquidityUsd - a.liquidityUsd);
  } catch (e: any) {
    console.error(
      `❌ getAllValidPairs error for token ${tokenAddress} on ${chain}: ${
        e?.message || e
      }`
    );
    return [];
  }
}

// getBnbPrice → getNativePrice: chain onujayi auto detect
async function getNativePrice(chain: ChainId): Promise<number> {
  if (chain === "bsc") {
    try {
      const res = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"
      );
      const data: any = await res.json();
      return parseFloat(data.price);
    } catch {
      return 875;
    }
  } else {
    try {
      const res = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"
      );
      const data: any = await res.json();
      return parseFloat(data.price);
    } catch {
      return 3400;
    }
  }
}

// Real previous balance at a given block (for position %)
async function getPreviousBalance(
  chain: ChainId,
  token: string,
  wallet: string,
  block: number
): Promise<bigint> {
  try {
    const runtime = runtimes.get(chain);
    if (!runtime) return 0n;

    const tokenContract = new ethers.Contract(
      token,
      ["function balanceOf(address) view returns (uint256)"],
      runtime.provider
    );

    const balance: ethers.BigNumber = await tokenContract.balanceOf(wallet, {
      blockTag: block
    });
    return balance.toBigInt();
  } catch {
    return 0n;
  }
}
