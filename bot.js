import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { loadConfig } from "./config.js";
import { t } from "./i18n.js";
import { sendFile } from "./send.js";
import { getActiveSession, setActiveSession, clearActiveSession, listClaudeSessions, findSession } from "./session.js";

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

  const IDLE_TIMEOUT = 180_000;       // kill after 3 min without ANY stdout data
  const PROGRESS_INTERVAL = 10_000;   // send/edit progress every 10s

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
      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
      ];
      if (config.skipPermissions) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);
      if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);

      // Session management: resume active session or assign explicit ID for new ones
      let activeSessionId = getActiveSession(chatId);
      if (activeSessionId) {
        args.push("--resume", activeSessionId);
      } else {
        activeSessionId = randomUUID();
        args.push("--session-id", activeSessionId);
        setActiveSession(chatId, activeSessionId);
      }

      args.push(prompt);

      const proc = spawn("claude", args, {
        cwd: config.workingDir,
        env: { ...process.env, LANG: "en_US.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      let activities = [];        // log of what claude is doing
      let currentTool = null;
      let currentToolName = null;
      let currentToolInput = "";
      let createdFiles = [];      // file paths from Write/Edit tool_use
      let settled = false;
      let lineBuf = "";
      let stderr = "";
      let lastActivityCount = 0;

      // ── rolling idle timeout ──
      let idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);

      function resetIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);
      }

      function killIdle() {
        if (!settled) {
          proc.kill("SIGTERM");
          cleanup();
          reject(new Error("claude timed out (no output for 3 min)"));
        }
      }

      function addActivity(icon, text) {
        const ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        activities.push(`${icon} [${ts}] ${text}`);
        // keep last 15 activities
        if (activities.length > 15) activities = activities.slice(-15);
      }

      // ── parse stream-json events ──
      function handleEvent(line) {
        if (!line.trim()) return;

        let ev;
        try { ev = JSON.parse(line); } catch { return; }

        // system events (init, api retries, etc)
        if (ev.type === "system") {
          addActivity("⚙️", ev.message || ev.subtype || "system event");
        }

        if (ev.type === "stream_event") {
          const e = ev.event;

          // text being generated
          if (e?.delta?.type === "text_delta" && e.delta.text) {
            resultText += e.delta.text;
            if (!currentTool) {
              currentTool = "writing";
            }
          }

          // tool use started
          if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
            const name = e.content_block.name || "tool";
            currentTool = name;
            currentToolName = name;
            currentToolInput = "";
            addActivity("🔧", name);
          }

          // text block started
          if (e?.type === "content_block_start" && e.content_block?.type === "text") {
            currentTool = "writing";
            addActivity("✍️", "Generating text...");
          }

          // tool input — accumulate to extract file_path
          if (e?.delta?.type === "input_json_delta" && e.delta.partial_json) {
            currentToolInput += e.delta.partial_json;
          }

          // block finished — extract file_path from Write/Edit tools
          if (e?.type === "content_block_stop") {
            if (currentToolName && /^(Write|Edit|write|edit)$/.test(currentToolName) && currentToolInput) {
              try {
                const input = JSON.parse(currentToolInput);
                if (input.file_path) createdFiles.push(input.file_path);
              } catch {}
            }
            currentTool = null;
            currentToolName = null;
            currentToolInput = "";
          }
        }

        // assistant turn complete
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use") {
                addActivity("🔧", `${block.name}(${summarizeInput(block.input)})`);
              }
              if (block.type === "tool_result") {
                addActivity("✅", `Result received`);
              }
            }
          }
        }

        // final result
        if (ev.type === "result") {
          if (ev.result) resultText = ev.result;
        }
      }

      function summarizeInput(input) {
        if (!input) return "";
        const s = JSON.stringify(input);
        return s.length > 80 ? s.slice(0, 80) + "…" : s;
      }

      // ── periodic progress updates as new messages ──
      const progressTimer = setInterval(() => sendProgress(), PROGRESS_INTERVAL);

      async function sendProgress() {
        if (settled) return;

        // only send if there are new activities
        if (activities.length === lastActivityCount) return;

        const newActivities = activities.slice(lastActivityCount);
        lastActivityCount = activities.length;

        const log = newActivities.join("\n");

        const preview = resultText.length > 0
          ? `\n\n📝 (${Math.round(resultText.length / 1024)}kb written)`
          : "";

        const text = `${log}${preview}`;
        const truncated = text.length > 4000 ? "…" + text.slice(-4000) : text;

        try {
          await bot.sendMessage(chatId, truncated);
        } catch {}
      }

      function cleanup() {
        settled = true;
        clearTimeout(idleTimer);
        clearInterval(progressTimer);
      }

      // ── parse newline-delimited JSON from stdout ──
      proc.stdout.on("data", (chunk) => {
        resetIdle();
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop();
        for (const line of lines) handleEvent(line);
      });

      proc.stderr.on("data", (d) => {
        stderr += d;
        resetIdle();
      });

      proc.on("close", async (code) => {
        if (settled) return;
        if (lineBuf.trim()) handleEvent(lineBuf);
        cleanup();
        if (code === 0) resolve({ text: resultText.trim(), files: createdFiles });
        else reject(new Error(`claude exit ${code}: ${stderr}`));
      });

      proc.on("error", (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      });
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
    clearActiveSession(m.chat.id);
    await bot.sendMessage(m.chat.id, msg.sessionCleared);
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /new (session cleared)`);
  });

  bot.onText(/\/status$/, async (m) => {
    if (!isAllowed(m)) return;
    const chatId = m.chat.id;
    const activeId = getActiveSession(chatId);
    const session = activeId ? findSession(config.workingDir, activeId) : null;
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
    const sessions = listClaudeSessions(config.workingDir);
    const activeId = getActiveSession(chatId);

    if (sessions.length === 0) {
      await bot.sendMessage(chatId, msg.noSessions || "No sessions yet. Send a message to start one.");
      return;
    }

    const buttons = sessions.slice(0, 10).map((s) => {
      const date = new Date(s.modified).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const count = s.messageCount || 0;
      const preview = (s.summary || s.firstPrompt || "...").slice(0, 40);
      const isActive = s.sessionId === activeId;
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
    const entry = findSession(config.workingDir, sessionId);

    if (entry) {
      setActiveSession(chatId, sessionId);
      const preview = (entry.summary || entry.firstPrompt || sessionId.slice(0, 8)).slice(0, 40);
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
        const { text: response, files } = await callClaude(text, chatId);
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

        // Send any files created/modified by Claude
        if (files && files.length > 0) {
          for (const filePath of files) {
            try {
              if (existsSync(filePath)) {
                await sendFile(bot, chatId, filePath);
                console.log(`[${new Date().toISOString()}] -> sent file: ${filePath}`);
              }
            } catch (fileErr) {
              console.error(`Failed to send file ${filePath}:`, fileErr.message);
            }
          }
        }

        console.log(`[${new Date().toISOString()}] -> replied (${response.length} chars)`);
      } catch (err) {
        clearInterval(typingInterval);
        console.error("Error:", err.message);

        // Session error recovery: if resume failed, clear session and retry
        if (err.message && err.message.includes("session")) {
          console.log(`[${new Date().toISOString()}] Session error for chat ${chatId}, retrying fresh...`);
          clearActiveSession(chatId);
          try {
            const { text: retryResponse } = await callClaude(text, chatId);
            if (retryResponse) {
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
