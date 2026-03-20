import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import { loadConfig } from "./config.js";
import { t } from "./i18n.js";

export function startBot(configOverride) {
  const config = configOverride || loadConfig();
  const msg = t(config.language);

  if (!config.token) {
    console.error(msg.tokenNotConfigured);
    process.exit(1);
  }

  const bot = new TelegramBot(config.token, { polling: true });
  const allowed = config.allowedUsers.map(Number);

  function callClaude(prompt) {
    return new Promise((resolve, reject) => {
      const args = ["--print"];
      if (config.skipPermissions) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);
      if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);
      args.push(prompt);

      const proc = spawn("claude", args, {
        cwd: config.workingDir,
        env: { ...process.env, LANG: "en_US.UTF-8" },
        timeout: 120_000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));

      proc.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude exit ${code}: ${stderr}`));
      });

      proc.on("error", reject);
    });
  }

  function splitMessage(text, maxLen = 4000) {
    const parts = [];
    while (text.length > 0) {
      if (text.length <= maxLen) {
        parts.push(text);
        break;
      }
      let cut = text.lastIndexOf("\n", maxLen);
      if (cut <= 0) cut = maxLen;
      parts.push(text.slice(0, cut));
      text = text.slice(cut).trimStart();
    }
    return parts;
  }

  bot.on("message", async (m) => {
    const chatId = m.chat.id;
    const userId = m.from?.id;
    const text = m.text;

    if (!text) return;

    if (allowed.length > 0 && !allowed.includes(userId)) {
      console.log(msg.gatewayBlocked(userId, m.from?.username));
      return;
    }

    console.log(`[${new Date().toISOString()}] ${m.from?.username}: ${text}`);

    bot.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    try {
      const response = await callClaude(text);
      clearInterval(typingInterval);

      if (!response) {
        await bot.sendMessage(chatId, msg.noResponse);
        return;
      }

      const parts = splitMessage(response);
      for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: "Markdown" }).catch(
          () => bot.sendMessage(chatId, part)
        );
      }

      console.log(`[${new Date().toISOString()}] -> replied (${response.length} chars)`);
    } catch (err) {
      clearInterval(typingInterval);
      console.error("Error:", err.message);
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });

  console.log("");
  console.log(`  \x1b[1m${msg.gatewayStarted}\x1b[0m`);
  console.log(`  ${msg.gatewayModel}:        ${config.model || "default"}`);
  console.log(`  ${msg.gatewayDirectory}:    ${config.workingDir}`);
  console.log(`  ${msg.gatewayPermissions}:  ${config.skipPermissions ? msg.autonomous : msg.askApproval}`);
  console.log(`  ${msg.gatewayAllowed}:      ${allowed.length > 0 ? allowed.join(", ") : msg.allUsers}`);
  console.log("");
  console.log(`  ${msg.gatewayWaiting}`);
  console.log("");

  return bot;
}
