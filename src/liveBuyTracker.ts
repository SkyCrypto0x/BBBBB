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
  volume5m: number;
  priceUsd: number;
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
        const [token0, token1] = await Promise.all([
          contract.token0(),
          contract.token1()
        ]);

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
      settings.allPairAddresses.some(
        (p) => p.toLowerCase() === pairAddress.toLowerCase()
      )
    ) {
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

  // ---- DexScreener data: price, MC, 5m volume, token symbol ----
  let priceNative = 0;
  let priceUsd = 0;
  let marketCap = 0;
  let volume5m = 0;
  let tokenDecimals = 18;
  let tokenSymbol = "TOKEN";

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`
    );
    const data: any = await res.json();
    if (data?.pair) {
      priceUsd = parseFloat(data.pair.priceUsd || "0");
      priceNative = parseFloat(data.pair.priceNative || "0");
      marketCap = data.pair.fdv || 0;
      // 24h volume থেকে আনুমানিক 5m volume (24h = 24*60 মিনিট, প্রতি 5 মিনিটে 24*12 slot)
      volume5m = data.pair.volume?.h24
        ? data.pair.volume.h24 / (24 * 12)
        : data.pair.volume?.m5 || 0;
      tokenSymbol = data.pair.baseToken?.symbol || "TOKEN";
      tokenDecimals = data.pair.baseToken?.decimals || 18;
    }
  } catch (e) {
    console.error("DexScreener pair fetch failed:", e);
  }

  // Native token price (BNB / ETH) from Binance
  const nativePriceUsd =
    String(chain).toLowerCase() === "bsc"
      ? await getBnbPrice()
      : await getEthPrice();

  const usdValue = baseAmount * nativePriceUsd;

  // ✅ token amount from on-chain amount + decimals
  let tokenAmount = 0;
  tokenAmount = parseFloat(ethers.utils.formatUnits(tokenOut, tokenDecimals));

  // Position increase based on previous balance
  const buyer = ethers.utils.getAddress(to); // checksum address
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
    const increase = Number((diff * 1000n) / prevBalance) / 10; // one decimal
    positionIncrease = Math.round(increase); // e.g. 123.4 -> 123
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
      volume5m,
      priceUsd
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
    volume5m
  } = data;

  const buyUsd = Math.round(usdValue);
  if (buyUsd < settings.minBuyUsd) return;
  if (settings.maxBuyUsd && buyUsd > settings.maxBuyUsd) return;

  const emojiCount = Math.floor(
    buyUsd / (settings.dollarsPerEmoji || 50)
  );
  const emojiBar = settings.emoji.repeat(Math.min(50, emojiCount));

  const chainStr = String(chain).toLowerCase();
  const baseSymbol =
    chainStr === "bsc"
      ? "BNB"
      : chainStr.includes("eth")
      ? "ETH"
      : "NATIVE";

  const explorerBase =
    appConfig.chains[chain]?.explorer ||
    (chainStr === "bsc"
      ? "https://bscscan.com"
      : "https://etherscan.io");

  const txUrl = `${explorerBase}/tx/${txHash}`;
  const addrUrl = `${explorerBase}/address/${buyer}`;

  const mcText = marketCap > 0 ? (marketCap / 1e6).toFixed(2) : "0.00";
  const vol5Text =
    volume5m > 0 ? (volume5m / 1e3).toFixed(0) : "0";

  const whaleLoadLine =
    positionIncrease !== null && positionIncrease > 500
      ? "🚀 <b>WHALE LOADING HEAVILY!</b>\n"
      : "";

  const whaleOrNewBuyLine =
    buyUsd > 10_000
      ? "🐳 <b>WHALE ALERT!!!</b>"
      : "🟢 <b>New Buy</b>";

  const message = `
🚨 <b>BIG BUY DETECTED!</b> 🚨
${whaleLoadLine}${whaleOrNewBuyLine}

💰 <b>$${buyUsd.toLocaleString()}</b> ${tokenSymbol} BUY
${emojiBar}

🟢 ${baseSymbol}: ${baseAmount.toFixed(4)} ($${buyUsd.toLocaleString()})
🪙 ${tokenSymbol}: ${Math.round(tokenAmount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}

👤 Buyer: <a href="${addrUrl}">${shorten(buyer)}</a>
🧾 <a href="${txUrl}">View Transaction</a>
${
  positionIncrease !== null
    ? `🧠 <b>Position Increased: +${positionIncrease.toFixed(0)}%</b>\n`
    : ""
}📊 MC: $${mcText}M
🔥 Vol (est. 5m): $${vol5Text}K
  `.trim();

  const dexScreenerUrl = `https://dexscreener.com/${chain}/${settings.pairAddress}`;
  const dexToolsUrl = `https://www.dextools.io/app/${
    chainStr === "bsc" ? "bsc" : "ether"
  }/pair-explorer/${settings.pairAddress}`;

  const keyboard: any = {
    inline_keyboard: [
      [
        { text: "📊 DexScreener", url: dexScreenerUrl },
        { text: "📈 DexTools", url: dexToolsUrl }
      ],
      settings.tgGroupLink
        ? [{ text: "👥 Join Alpha Group", url: settings.tgGroupLink }]
        : [],
      [
        {
          text: "✉️ DM for Access",
          url: "https://t.me/yourusername" // এখানে নিজের username বসাও
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

async function getBnbPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"
    );
    const data: any = await res.json();
    return parseFloat(data.price);
  } catch {
    return 600; // fallback
  }
}

async function getEthPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"
    );
    const data: any = await res.json();
    return parseFloat(data.price);
  } catch {
    return 3000; // fallback
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
  } catch (e) {
    return 0n;
  }
}
