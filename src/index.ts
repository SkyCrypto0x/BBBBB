import { Telegraf } from "telegraf";
import { appConfig } from "./rpcAndApi";
import { registerBuyBotFeature } from "./feature.buyBot";

async function main() {
  const bot = new Telegraf(appConfig.telegramBotToken);

  // Register /start + setup flow
  registerBuyBotFeature(bot);

  // Optional: command list
  await bot.telegram.setMyCommands([
    { command: "start", description: "Start / configure the buy bot" }
  ]);

  await bot.launch();
  console.log("✅ Buy bot is running…");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
