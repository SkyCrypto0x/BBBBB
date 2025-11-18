import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import { appConfig, ChainId } from "./rpcAndApi";
import { groupSettings, BuyBotSettings } from "./feature.buyBot";

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
  pairs: Map<string, PairRuntime>; // pairAddress -> runtime
}

// chainId -> runtime
const runtimes = new Map<ChainId, ChainRuntime>();

export function startLiveBuyTracker(bot: Telegraf) {
  // first run immediately
  syncListeners(bot).catch((e) =>
    console.error("initial syncListeners error", e)
  );

  // then every 15s resync
  setInterval(() => {
    syncListeners(bot).catch((e) => console.error("syncListeners error", e));
  }, 15000);
}

async function syncListeners(bot: Telegraf) {
  console.log("🔁 Syncing live listeners…");

  for (const [groupId, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

    console.log(
      `  • group ${groupId} on chain ${chain}, pairs: ${settings.allPairAddresses.length}`
    );

    let runtime = runtimes.get(chain);
    if (!runtime) {
      const rpc = chainCfg.rpcUrl;

      const provider = rpc.startsWith("wss")
        ? new ethers.providers.WebSocketProvider(rpc)
        : new ethers.providers.JsonRpcProvider(rpc);

      runtime = {
        provider,
        pairs: new Map()
      };
      runtimes.set(chain, runtime);

      console.log(`🔗 Live tracker: connected to ${chain} RPC`);
    }

    // ensure every pair has a listener
    for (const pair of settings.allPairAddresses) {
      const addr = pair.toLowerCase();
      if (runtime.pairs.has(addr)) continue;

      try {
        const contract = new ethers.Contract(addr, PAIR_ABI, runtime.provider);
        const token0 = (await contract.token0()).toLowerCase();
        const token1 = (await contract.token1()).toLowerCase();

        runtime.pairs.set(addr, { contract, token0, token1 });

        console.log(
          `🛰️ Listening Swap events on ${chain} pair ${addr} (token0=${token0}, token1=${token1})`
        );

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
              addr,
              { token0, token1 },
              event.transactionHash,
              amount0In,
              amount1In,
              amount0Out,
              amount1Out
            );
          }
        );
      } catch (e) {
        console.error("Error attaching listener to pair", addr, e);
      }
    }
  }
}

function handleSwap(
  bot: Telegraf,
  chain: ChainId,
  pairAddress: string,
  pairTokens: { token0: string; token1: string },
  txHash: string,
  amount0In: ethers.BigNumber,
  amount1In: ethers.BigNumber,
  amount0Out: ethers.BigNumber,
  amount1Out: ethers.BigNumber
) {
  // find all groups that use this pair on this chain
  const relatedGroups: Array<[number, BuyBotSettings]> = [];
  for (const [groupId, settings] of groupSettings.entries()) {
    if (
      settings.chain === chain &&
      settings.allPairAddresses
        .map((p) => p.toLowerCase())
        .includes(pairAddress)
    ) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (!relatedGroups.length) return;

  const settings = relatedGroups[0][1];
  const tokenAddr = settings.tokenAddress.toLowerCase();

  const isToken0 = pairTokens.token0 === tokenAddr;
  const isToken1 = pairTokens.token1 === tokenAddr;
  if (!isToken0 && !isToken1) return; // safety

  let rawTokenOut: ethers.BigNumber;
  let rawBaseIn: ethers.BigNumber;

  if (isToken0) {
    rawTokenOut = amount0Out;
    rawBaseIn = amount1In;
  } else {
    rawTokenOut = amount1Out;
    rawBaseIn = amount0In;
  }

  if (rawTokenOut.lte(0)) {
    // probably a sell; ignore (later we can add sell alerts)
    return;
  }

  // Approx decimal 18 (most ERC20/WBNB)
  const tokenAmount = parseFloat(ethers.utils.formatUnits(rawTokenOut, 18));
  const baseAmount = parseFloat(ethers.utils.formatUnits(rawBaseIn, 18));

  console.log(
    `💹 Buy on pair ${pairAddress}, tx ${txHash}, tokenAmount=${tokenAmount}, baseIn=${baseAmount}`
  );

  for (const [groupId, s] of relatedGroups) {
    sendBuyAlert(bot, groupId, s, tokenAmount, baseAmount, txHash);
  }
}

function sendBuyAlert(
  bot: Telegraf,
  groupId: number,
  settings: BuyBotSettings,
  tokenAmount: number,
  baseAmount: number,
  txHash: string
) {
  const min = settings.minBuyUsd ?? 0;
  const max = settings.maxBuyUsd;

  // এখানে baseAmount কে "size" হিসেবে ধরি (e.g. BNB amount)
  if (min && baseAmount < min) return;
  if (max && baseAmount > max) return;

  const per = settings.dollarsPerEmoji || 1;
  const emojiCount = Math.min(
    30,
    Math.max(1, Math.round(baseAmount / per))
  );
  const emojiBar = settings.emoji.repeat(emojiCount || 1);

  const explorer = appConfig.chains[settings.chain]?.explorer ?? "";
  const txUrl = explorer ? `${explorer}/tx/${txHash}` : txHash;
  const mainPairUrl = `https://dexscreener.com/${settings.chain}/${settings.pairAddress}`;

  const text =
    "🧠 <b>Premium Buy Alert</b>\n\n" +
    `<b>${baseAmount.toFixed(4)} BUY</b>\n` +
    `${emojiBar}\n\n` +
    `🪙 <b>Token:</b> <code>${shorten(settings.tokenAddress)}</code>\n` +
    `🧬 <b>Main pair:</b> <code>${shorten(settings.pairAddress)}</code>\n` +
    (settings.allPairAddresses.length > 1
      ? `🌊 <b>Total pools:</b> ${settings.allPairAddresses.length}\n`
      : "") +
    `📊 <a href="${mainPairUrl}">DexScreener chart</a>\n` +
    (explorer ? `🔗 <a href="${txUrl}">BscScan tx</a>` : "");

  // visuals same priority order as /testbuy
  if (settings.animationFileId) {
    bot.telegram
      .sendAnimation(groupId, settings.animationFileId, {
        caption: text,
        parse_mode: "HTML"
      })
      .catch((e) => console.error("sendAnimation error", e));
    return;
  }

  if (settings.imageFileId) {
    bot.telegram
      .sendPhoto(groupId, settings.imageFileId, {
        caption: text,
        parse_mode: "HTML"
      })
      .catch((e) => console.error("sendPhoto error", e));
    return;
  }

  if (settings.imageUrl) {
    const lower = settings.imageUrl.toLowerCase();
    if (lower.endsWith(".gif")) {
      bot.telegram
        .sendAnimation(groupId, settings.imageUrl, {
          caption: text,
          parse_mode: "HTML"
        })
        .catch((e) => console.error("sendAnimation error", e));
    } else {
      bot.telegram
        .sendPhoto(groupId, settings.imageUrl, {
          caption: text,
          parse_mode: "HTML"
        })
        .catch((e) => console.error("sendPhoto error", e));
    }
    return;
  }

  bot.telegram
    .sendMessage(groupId, text, { parse_mode: "HTML" })
    .catch((e) => console.error("sendMessage error", e));
}

function shorten(addr: string, len = 6): string {
  if (!addr || addr.length <= len * 2) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}
