import { Telegraf } from "telegraf";
import { appConfig } from "./rpcAndApi";
import { registerBuyBotFeature } from "./feature.buyBot";

async function main() {
  const bot = new Telegraf(appConfig.telegramBotToken);

  registerBuyBotFeature(bot);

  await bot.launch();
  console.log("Buy bot setup flow running…");

  // graceful stop (optional)
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
