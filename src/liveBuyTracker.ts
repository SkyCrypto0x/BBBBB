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

// public API from this file
export function startLiveBuyTracker(bot: Telegraf) {
  // every 15s we scan settings and ensure listeners attached
  setInterval(() => {
    syncListeners(bot).catch((e) => console.error("syncListeners error", e));
  }, 15000);
}

async function syncListeners(bot: Telegraf) {
  // loop all configured groups
  for (const [, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

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

  // For now assume all groups share the same tokenAddress for this pair
  const settings = relatedGroups[0][1];
  const tokenAddr = settings.tokenAddress.toLowerCase();

  const isToken0 = pairTokens.token0 === tokenAddr;
  const isToken1 = pairTokens.token1 === tokenAddr;
  if (!isToken0 && !isToken1) return; // safety

  // UniswapV2/PancakeV2 convention:
  // - "buy" of our token = tokenOut > 0 and other asset In > 0
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

  // Approximate decimals as 18 (most BSC tokens & WBNB)
  const tokenAmount = parseFloat(
    ethers.utils.formatUnits(rawTokenOut, 18)
  );
  const baseAmount = parseFloat(
    ethers.utils.formatUnits(rawBaseIn, 18)
  );

  // send alert to all related groups
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
  // simple min/max filter using baseAmount as proxy (BNB spent)
  const min = settings.minBuyUsd ?? 0;
  const max = settings.maxBuyUsd;

  if (min && baseAmount < min) return;
  if (max && baseAmount > max) return;

  // emojis based on "size" – here token amount approx
  const per = settings.dollarsPerEmoji || 1;
  const emojiCount = Math.min(
    30,
    Math.max(1, Math.round(tokenAmount / per))
  );
  const emojiBar = settings.emoji.repeat(emojiCount || 1);

  const explorer = appConfig.chains[settings.chain]?.explorer ?? "";
  const txUrl = explorer ? `${explorer}/tx/${txHash}` : txHash;

  const text =
    "🧠 <b>Live Buy Detected</b>\n\n" +
    `${emojiBar}\n\n` +
    `🪙 <b>Token:</b> <code>${shorten(settings.tokenAddress)}</code>\n` +
    `💰 <b>Token amount:</b> ${tokenAmount.toFixed(4)}\n` +
    `🟡 <b>Base spent:</b> ${baseAmount.toFixed(4)} (e.g. BNB)\n` +
    `🔗 <a href="${txUrl}">View on ${explorer || "explorer"}</a>`;

  bot.telegram
    .sendMessage(groupId, text, { parse_mode: "HTML" })
    .catch((e) => console.error("sendMessage error", e));
}

function shorten(addr: string, len = 6): string {
  if (!addr || addr.length <= len * 2) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}
