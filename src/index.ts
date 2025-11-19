import { Telegraf } from "telegraf";
import { appConfig } from "./rpcAndApi";
import { registerBuyBotFeature } from "./feature.buyBot";
import { startLiveBuyTracker } from "./liveBuyTracker";

async function main() {
  const bot = new Telegraf(appConfig.telegramBotToken);

  registerBuyBotFeature(bot);
  startLiveBuyTracker(bot); // 🔥 on-chain listeners

  await bot.telegram.setMyCommands([
    { command: "start", description: "Show bot info / help" },
    { command: "add", description: "Add or edit token settings" },
    { command: "testbuy", description: "Preview a premium buy alert" }
  ]);

  await bot.launch();
  console.log("✅ Premium Buy Bot is running with live tracking…");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});