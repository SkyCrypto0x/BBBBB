import { Telegraf, Context, Markup } from "telegraf";
import { appConfig, ChainId, resolvePairFromToken } from "./rpcAndApi";

export interface BuyBotSettings {
  chain: ChainId;
  tokenAddress: string;
  pairAddress: string;
  emoji: string;
  imageUrl?: string;
  minBuyUsd: number;
  maxBuyUsd?: number;
  dollarsPerEmoji: number;
  tgGroupLink?: string;
  autoPinDataPosts: boolean;
  autoPinKolAlerts: boolean;
}

// groupId -> final premium settings
export const groupSettings = new Map<number, BuyBotSettings>();

type SetupStep =
  | "token"
  | "pair"
  | "emoji"
  | "image"
  | "minBuy"
  | "maxBuy"
  | "perEmoji"
  | "tgGroup";

interface BaseSetupState {
  step: SetupStep;
  settings: Partial<BuyBotSettings>;
}

// DM flow: per-user state (targetChatId = je group configure korche)
interface DmSetupState extends BaseSetupState {
  targetChatId: number;
}

// Group flow: per-group state
interface GroupSetupState extends BaseSetupState {}

const dmSetupStates = new Map<number, DmSetupState>();      // userId -> state
const groupSetupStates = new Map<number, GroupSetupState>(); // chatId -> state

type BotCtx = Context;

export function registerBuyBotFeature(bot: Telegraf<BotCtx>) {
  // 🔹 /start – DM + group দুদিকেই premium UX
  bot.start(async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    const payload = (ctx as any).startPayload as string | undefined;

    // DM with payload: deep-link from group -> start wizard for that group
    if (chat.type === "private" && payload && payload.startsWith("setup_")) {
      const groupId = Number(payload.replace("setup_", ""));
      const userId = ctx.from!.id;

      dmSetupStates.set(userId, {
        step: "token",
        targetChatId: groupId,
        settings: {
          chain: appConfig.defaultChain
        }
      });

      await ctx.reply(
        "🕵️ <b>Premium Buy Bot Setup</b>\n\n" +
          "1️⃣ Send your <b>token contract address</b>.\n" +
          "I'll auto-detect your main pair from DexScreener.",
        { parse_mode: "HTML" }
      );
      return;
    }

    // DM normal /start – welcome + Add to group button
    if (chat.type === "private") {
      const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;

      await ctx.reply(
        "🕵️ <b>Premium Buy Bot</b>\n\n" +
          "• Tracks every buy for your token\n" +
          "• Beautiful GIF/emoji alerts\n" +
          "• Min & max buy filters\n" +
          "• Designed for degen + pro projects.\n\n" +
          "➊ Press the button below to <b>add me to your group</b>.\n" +
          "➋ In the group, use <code>/add</code> to configure.",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.url("➕ Add to group", addToGroupUrl)]
          ])
        }
      );
      return;
    }

    // Group /start – high level help
    if (chat.type === "group" || chat.type === "supergroup") {
      await sendGroupHelp(ctx);
      return;
    }
  });

  // 🔹 /add – main premium entry point (group + DM)
  bot.command("add", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    // DM: politely explain flow (must come via group)
    if (chat.type === "private") {
      const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;
      await ctx.reply(
        "To configure a token, please:\n\n" +
          "1️⃣ Add me to your token's group\n" +
          "2️⃣ In the group, type <code>/add</code>\n" +
          "3️⃣ Tap <b>Set up in DM</b> or <b>Set up here</b>",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.url("➕ Add to group", addToGroupUrl)]
          ])
        }
      );
      return;
    }

    // Group: offer DM setup + in-group setup
    if (chat.type === "group" || chat.type === "supergroup") {
      const groupId = chat.id;
      const setupDmUrl = `https://t.me/${appConfig.botUsername}?start=setup_${groupId}`;

      // reset any previous state for this group
      groupSetupStates.delete(groupId);

      const text =
        "🕵️ <b>Premium Buy Bot Setup</b>\n\n" +
        "Choose how you want to configure:\n\n" +
        "• <b>Set up in DM</b> – full wizard in private chat (recommended)\n" +
        "• <b>Set up here</b> – answer questions directly in this group";

      await ctx.reply(text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.url("💬 Set up in DM", setupDmUrl),
            Markup.button.callback("🏠 Set up here", "setup_here")
          ]
        ])
      });

      return;
    }
  });

  // Group inline button: "Set up here"
  bot.action("setup_here", async (ctx) => {
    const chat = ctx.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
      await ctx.answerCbQuery("Use this inside your project group.");
      return;
    }

    const chatId = chat.id;
    groupSetupStates.set(chatId, {
      step: "token",
      settings: { chain: appConfig.defaultChain }
    });

    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(
      "🕵️ <b>Group Setup Mode</b>\n\n" +
        "1️⃣ Reply with your <b>token contract address</b>.\n" +
        "I'll auto-detect the main pair from DexScreener.",
      { parse_mode: "HTML" }
    );

    await ctx.answerCbQuery();
  });

  // 🔹 Text handler – DM + group wizard (token → emoji → gif → min/max buy → $/emoji → group link)
  bot.on("text", async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();

    const text = ctx.message.text.trim();

    // DM wizard
    if (chat.type === "private") {
      const userId = ctx.from!.id;
      const state = dmSetupStates.get(userId);
      if (!state) return next();

      const final = await runSetupStep(ctx, state, text);
      if (final) {
        groupSettings.set(state.targetChatId, final);
        dmSetupStates.delete(userId);

        await ctx.reply(
          "✅ Premium setup complete!\n" +
            "Go back to your group – the buy bot is now configured for that chat."
        );
      }
      return;
    }

    // Group wizard
    if (chat.type === "group" || chat.type === "supergroup") {
      const chatId = chat.id;
      const state = groupSetupStates.get(chatId);
      if (!state) return next(); // no active wizard

      const final = await runSetupStep(ctx, state, text);
      if (final) {
        groupSettings.set(chatId, final);
        groupSetupStates.delete(chatId);

        await ctx.reply(
          "✅ Premium setup complete for this group!\n" +
            "The buy bot is ready. (On-chain listener will use these settings.)"
        );
      }
      return;
    }

    return next();
  });
}

// 🔧 Shared wizard logic (DM + group) – ekdom premium steps
async function runSetupStep(
  ctx: Context,
  state: BaseSetupState,
  text: string
): Promise<BuyBotSettings | null> {
  switch (state.step) {
    case "token": {
      state.settings.tokenAddress = text;
      await ctx.reply("🔎 Searching main pair on DexScreener…");

      const pair = await resolvePairFromToken(
        state.settings.chain || appConfig.defaultChain,
        text
      );

      if (!pair) {
        state.step = "pair";
        await ctx.reply(
          "❌ Could not auto-detect pair.\n\n" +
            "2️⃣ Please send the <b>pair address</b> (DEX pool) for your token.",
          { parse_mode: "HTML" }
        );
        return null;
      }

      state.settings.pairAddress = pair;
      state.step = "emoji";
      await ctx.reply(
        `✅ Found main pair:\n<code>${pair}</code>\n\n` +
          "3️⃣ Now send a <b>buy emoji</b> (e.g. 🐶, 🧠, 🚀).",
        { parse_mode: "HTML" }
      );
      return null;
    }

    case "pair": {
      state.settings.pairAddress = text;
      state.step = "emoji";
      await ctx.reply(
        "3️⃣ Choose a buy emoji (send just one emoji, e.g. 🐶 or 🧠)."
      );
      return null;
    }

    case "emoji": {
      state.settings.emoji = text;
      state.step = "image";
      await ctx.reply(
        "4️⃣ Send an <b>image / gif URL</b> to show in each buy alert, or type <code>skip</code>.",
        { parse_mode: "HTML" }
      );
      return null;
    }

    case "image": {
      if (text.toLowerCase() !== "skip") {
        state.settings.imageUrl = text;
      }
      state.step = "minBuy";
      await ctx.reply(
        "5️⃣ Send <b>minimum $ buy</b> that will trigger an alert (e.g. 50).",
        { parse_mode: "HTML" }
      );
      return null;
    }

    case "minBuy": {
      const val = Number(text);
      if (isNaN(val) || val < 0) {
        await ctx.reply("Please send a valid number, e.g. 50");
        return null;
      }
      state.settings.minBuyUsd = val;
      state.step = "maxBuy";
      await ctx.reply(
        "6️⃣ (Optional) Send <b>maximum $ buy</b> to alert (e.g. 50000), or type <code>skip</code>.\n" +
          "Useful if you don't want huge whales to spam alerts.",
        { parse_mode: "HTML" }
      );
      return null;
    }

    case "maxBuy": {
      if (text.toLowerCase() !== "skip") {
        const val = Number(text);
        if (isNaN(val) || val <= 0) {
          await ctx.reply("Please send a positive number, or 'skip'.");
          return null;
        }
        state.settings.maxBuyUsd = val;
      }
      state.step = "perEmoji";
      await ctx.reply(
        "7️⃣ Send <b>$ per emoji</b> (e.g. 50 → every $50 = 1 emoji).\n\n" +
          "Example: $200 buy with $50 per emoji → 🐶🐶🐶🐶",
        { parse_mode: "HTML" }
      );
      return null;
    }

    case "perEmoji": {
      const val = Number(text);
      if (isNaN(val) || val <= 0) {
        await ctx.reply("Please send a positive number, e.g. 50");
        return null;
      }
      state.settings.dollarsPerEmoji = val;
      state.step = "tgGroup";
      await ctx.reply(
        "8️⃣ (Optional) Send your <b>Telegram group link</b> for better embedding, or type <code>skip</code>.",
        { parse_mode: "HTML" }
      );
      return null;
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
        maxBuyUsd: state.settings.maxBuyUsd,
        dollarsPerEmoji: state.settings.dollarsPerEmoji ?? 50,
        tgGroupLink: state.settings.tgGroupLink,
        autoPinDataPosts: state.settings.autoPinDataPosts ?? false,
        autoPinKolAlerts: state.settings.autoPinKolAlerts ?? false
      };

      return finalSettings;
    }
  }

  return null;
}

// Small helper: nice help text in group
async function sendGroupHelp(ctx: Context) {
  const chat = ctx.chat!;
  const addCmd = "/add";

  await ctx.reply(
    "🕵️ <b>Premium Buy Bot</b>\n\n" +
      "Use <code>" +
      addCmd +
      "</code> to configure this group.\n\n" +
      "Flow:\n" +
      "1) Run <code>/add</code>\n" +
      "2) Choose <b>Set up in DM</b> or <b>Set up here</b>\n" +
      "3) Token → Emoji → GIF → Min/Max buy → $ per emoji → Group link.\n\n" +
      "Once finished, the bot will use those settings for buy alerts.",
    { parse_mode: "HTML" }
  );
}
