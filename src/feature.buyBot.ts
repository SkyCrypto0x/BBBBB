import { Telegraf, Context, Markup } from "telegraf";
import { appConfig, ChainId, resolvePairFromToken } from "./rpcAndApi";

export interface BuyBotSettings {
  chain: ChainId;
  tokenAddress: string;
  pairAddress: string;
  emoji: string;
  imageUrl?: string;
  minBuyUsd: number;
  dollarsPerEmoji: number;
  tgGroupLink?: string;
  autoPinDataPosts: boolean;
  autoPinKolAlerts: boolean;
}

// groupId -> settings
export const groupSettings = new Map<number, BuyBotSettings>();

type SetupStep =
  | "token"
  | "pair"
  | "emoji"
  | "image"
  | "minBuy"
  | "perEmoji"
  | "tgGroup";

interface SetupState {
  step: SetupStep;
  targetChatId: number;
  settings: Partial<BuyBotSettings>;
}

const setupStates = new Map<number, SetupState>();

type BotCtx = Context;

export function registerBuyBotFeature(bot: Telegraf<BotCtx>) {
  // /start handler (group + private both)
  bot.start(async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    // 1) if /start in group → show "Set up buy bot" button
    if (chat.type === "group" || chat.type === "supergroup") {
      const groupId = chat.id;
      await ctx.reply(
        "🕵️ <b>Buy Bot Set-Up</b>\n\nClick the button below to configure in DM.",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.url(
                "Set up buy bot",
                `https://t.me/${appConfig.botUsername}?start=setup_${groupId}`
              ),
            ],
          ]),
        }
      );
      return;
    }

    // 2) if /start in private DM with payload "setup_<groupId>"
    if (chat.type === "private") {
      const payload = (ctx as any).startPayload as string | undefined;

      if (payload && payload.startsWith("setup_")) {
        const groupId = Number(payload.replace("setup_", ""));
        const userId = ctx.from!.id;

        setupStates.set(userId, {
          step: "token",
          targetChatId: groupId,
          settings: {
            chain: appConfig.defaultChain,
          },
        });

        await ctx.reply(
          "🕵️ Buy Bot Setup\n\n1️⃣ Send your *token contract address*.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      await ctx.reply(
        "Add me to your token's group, then type /start in that group to configure the buy bot."
      );
    }
  });

  // DM conversation for setup
  bot.on("text", async (ctx, next) => {
    if (ctx.chat?.type !== "private") return next();

    const userId = ctx.from!.id;
    const state = setupStates.get(userId);
    if (!state) return next();

    const text = ctx.message.text.trim();

    switch (state.step) {
      case "token": {
        state.settings.tokenAddress = text;
        await ctx.reply("🔎 Searching for your main pair on DexScreener…");

        const pair = await resolvePairFromToken(
          state.settings.chain || appConfig.defaultChain,
          text
        );

        if (!pair) {
          state.step = "pair";
          await ctx.reply(
            "Could not auto-detect pair.\n\n2️⃣ Please send the *pair address* (DEX pool) for your token.",
            { parse_mode: "Markdown" }
          );
          break;
        }

        state.settings.pairAddress = pair;
        state.step = "emoji";
        await ctx.reply(
          `✅ Found pair:\n<code>${pair}</code>\n\n3️⃣ Now send a *buy emoji* (e.g. 🐶, 🧠, 🚀).`,
          { parse_mode: "HTML" }
        );
        break;
      }

      case "pair": {
        state.settings.pairAddress = text;
        state.step = "emoji";
        await ctx.reply(
          "3️⃣ Choose a buy emoji (send just one emoji, e.g. 🐶 or 🧠)."
        );
        break;
      }

      case "emoji": {
        state.settings.emoji = text;
        state.step = "image";
        await ctx.reply(
          "4️⃣ Send an image / GIF URL to show in each buy alert, or type 'skip'."
        );
        break;
      }

      case "image": {
        if (text.toLowerCase() !== "skip") {
          state.settings.imageUrl = text;
        }
        state.step = "minBuy";
        await ctx.reply(
          "5️⃣ Send *minimum $ buy* that will trigger an alert (e.g. 50).",
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "minBuy": {
        const val = Number(text);
        if (isNaN(val) || val < 0) {
          await ctx.reply("Please send a valid number, e.g. 50");
          break;
        }
        state.settings.minBuyUsd = val;
        state.step = "perEmoji";
        await ctx.reply(
          "6️⃣ Send '$ per emoji' (e.g. 50 → every $50 = 1 emoji)."
        );
        break;
      }

      case "perEmoji": {
        const val = Number(text);
        if (isNaN(val) || val <= 0) {
          await ctx.reply("Please send a positive number, e.g. 50");
          break;
        }
        state.settings.dollarsPerEmoji = val;
        state.step = "tgGroup";
        await ctx.reply(
          "7️⃣ (Optional) Send your Telegram group link, or type 'skip'."
        );
        break;
      }

      case "tgGroup": {
        if (text.toLowerCase() !== "skip") {
          state.settings.tgGroupLink = text;
        }

        // defaults
        state.settings.autoPinDataPosts = false;
        state.settings.autoPinKolAlerts = false;

        const finalSettings: BuyBotSettings = {
          chain: state.settings.chain || appConfig.defaultChain,
          tokenAddress: state.settings.tokenAddress!,
          pairAddress: state.settings.pairAddress!,
          emoji: state.settings.emoji || "🟢",
          imageUrl: state.settings.imageUrl,
          minBuyUsd: state.settings.minBuyUsd ?? 0,
          dollarsPerEmoji: state.settings.dollarsPerEmoji ?? 50,
          tgGroupLink: state.settings.tgGroupLink,
          autoPinDataPosts: state.settings.autoPinDataPosts ?? false,
          autoPinKolAlerts: state.settings.autoPinKolAlerts ?? false,
        };

        groupSettings.set(state.targetChatId, finalSettings);
        setupStates.delete(userId);

        await ctx.reply(
          "✅ Setup complete!\nGo back to your group – the buy bot is ready to start (once you plug in the on-chain listener code)."
        );
        break;
      }
    }
  });
}
