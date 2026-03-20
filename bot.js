import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import { loadConfig } from "./config.js";
import { t } from "./i18n.js";
import { getSession, createSession, clearSession, resumeSession, touchSession, listSessions, getSessionCount } from "./session.js";

export function startBot(configOverride) {
  const config = configOverride || loadConfig();
  const msg = t(config.language);

  if (!config.token) {
    console.error(msg.tokenNotConfigured);
    process.exit(1);
  }

  const bot = new TelegramBot(config.token, { polling: true });
  const allowed = config.allowedUsers.map(Number);
  const startTime = Date.now();
  const chatLocks = new Map();

  // Register commands so they appear in Telegram UI
  bot.setMyCommands([
    { command: "new", description: msg.cmdNewDesc },
    { command: "sessions", description: msg.cmdSessionsDesc || "List sessions" },
    { command: "status", description: msg.cmdStatusDesc },
    { command: "start", description: msg.botWelcome },
  ]).catch(() => {});

  function formatUptime(ms) {
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function withChatLock(chatId, fn) {
    const key = String(chatId);
    const prev = chatLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    chatLocks.set(key, next);
    next.finally(() => {
      if (chatLocks.get(key) === next) chatLocks.delete(key);
    });
    return next;
  }

  function callClaude(prompt, chatId) {
    return new Promise((resolve, reject) => {
      const args = ["--print"];
      if (config.skipPermissions) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);
      if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);

      // Session management
      let session = getSession(chatId);
      if (session) {
        args.push("--resume", session.sessionId);
      } else {
        session = createSession(chatId, prompt);
        args.push("--session-id", session.sessionId);
      }

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

  // ── Native Telegram commands ──

  function isAllowed(m) {
    const userId = m.from?.id;
    if (allowed.length > 0 && !allowed.includes(userId)) {
      console.log(msg.gatewayBlocked(userId, m.from?.username));
      return false;
    }
    return true;
  }

  bot.onText(/\/start$/, async (m) => {
    if (!isAllowed(m)) return;
    await bot.sendMessage(m.chat.id, msg.botWelcome);
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /start`);
  });

  bot.onText(/\/new$/, async (m) => {
    if (!isAllowed(m)) return;
    clearSession(m.chat.id);
    await bot.sendMessage(m.chat.id, msg.sessionCleared);
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /new (session cleared)`);
  });

  bot.onText(/\/status$/, async (m) => {
    if (!isAllowed(m)) return;
    const chatId = m.chat.id;
    const session = getSession(chatId);
    const uptimeStr = formatUptime(Date.now() - startTime);
    let statusText = "";
    statusText += `*${msg.uptime}:* ${uptimeStr}\n`;
    statusText += `*${msg.gatewayModel}:* ${config.model || "sonnet"}\n`;
    if (session) {
      statusText += msg.sessionInfo(session.sessionId, session.messageCount || 0);
    } else {
      statusText += msg.sessionNone;
    }
    await bot.sendMessage(chatId, statusText, { parse_mode: "Markdown" }).catch(
      () => bot.sendMessage(chatId, statusText)
    );
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /status`);
  });

  bot.onText(/\/sessions$/, async (m) => {
    if (!isAllowed(m)) return;
    const chatId = m.chat.id;
    const { active, sessions } = listSessions(chatId);

    if (sessions.length === 0) {
      await bot.sendMessage(chatId, msg.noSessions || "No sessions yet. Send a message to start one.");
      return;
    }

    const buttons = sessions.slice(0, 10).map((s) => {
      const date = new Date(s.lastUsedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const count = s.messageCount || 0;
      const preview = s.summary || "...";
      const isActive = s.sessionId === active;
      const label = `${isActive ? "● " : ""}${preview} (${count} msgs, ${date})`;
      return [{ text: label, callback_data: `resume:${s.sessionId}` }];
    });

    await bot.sendMessage(chatId, msg.sessionsTitle || "*Sessions*\nTap to resume:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /sessions`);
  });

  // ── Inline keyboard callback (resume session) ──

  bot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message?.chat?.id;
    if (!chatId || !data?.startsWith("resume:")) return;

    const sessionId = data.slice(7);
    const entry = resumeSession(chatId, sessionId);

    if (entry) {
      const preview = entry.summary || entry.sessionId.slice(0, 8);
      await bot.answerCallbackQuery(query.id, { text: msg.sessionResumed || "Session resumed!" });
      await bot.sendMessage(chatId,
        `${msg.sessionResumedLong || "Resumed session:"} *${preview}*\n${msg.messagesInSession}: ${entry.messageCount}`,
        { parse_mode: "Markdown" }
      ).catch(() => bot.sendMessage(chatId, `Resumed: ${preview}`));
    } else {
      await bot.answerCallbackQuery(query.id, { text: msg.sessionNotFound || "Session not found" });
    }

    console.log(`[${new Date().toISOString()}] ${query.from?.username}: resume ${sessionId.slice(0, 8)}`);
  });

  // ── Regular messages ──

  bot.on("message", async (m) => {
    const chatId = m.chat.id;
    const userId = m.from?.id;
    const text = m.text;

    if (!text) return;

    // Skip commands — already handled by onText
    if (text.startsWith("/")) return;

    if (allowed.length > 0 && !allowed.includes(userId)) {
      console.log(msg.gatewayBlocked(userId, m.from?.username));
      return;
    }

    console.log(`[${new Date().toISOString()}] ${m.from?.username}: ${text}`);

    bot.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    await withChatLock(chatId, async () => {
      try {
        const response = await callClaude(text, chatId);
        clearInterval(typingInterval);

        if (!response) {
          await bot.sendMessage(chatId, msg.noResponse);
          return;
        }

        touchSession(chatId, text);

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

        // Session error recovery: if resume failed, clear session and retry
        if (err.message && err.message.includes("session")) {
          console.log(`[${new Date().toISOString()}] Session error for chat ${chatId}, retrying fresh...`);
          clearSession(chatId);
          try {
            const retryResponse = await callClaude(text, chatId);
            if (retryResponse) {
              touchSession(chatId, text);
              const parts = splitMessage(retryResponse);
              for (const part of parts) {
                await bot.sendMessage(chatId, part, { parse_mode: "Markdown" }).catch(
                  () => bot.sendMessage(chatId, part)
                );
              }
              console.log(`[${new Date().toISOString()}] -> retry replied (${retryResponse.length} chars)`);
              return;
            }
          } catch (retryErr) {
            console.error("Retry error:", retryErr.message);
          }
          await bot.sendMessage(chatId, msg.sessionRetry);
        } else {
          await bot.sendMessage(chatId, `Error: ${err.message}`);
        }
      }
    });
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
