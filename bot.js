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
  const pendingApprovals = new Map(); // approvalId -> { chatId, text, resolve }
  const unlockedChats = new Set();   // chats that approved permissions (until /lock or /new)

  const IDLE_TIMEOUT = 180_000;
  const PROGRESS_INTERVAL = 10_000;
  const APPROVAL_TIMEOUT = 120_000;

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

  // ── Intent classifier — quick haiku call to decide if approval is needed ──

  function classifyIntent(userText) {
    return new Promise((resolve) => {
      const classifyPrompt = `Classify this message. Reply with a single word: CHAT or ACTION.

CHAT = greetings, questions, conversation, explanations (no tools needed)
ACTION = create/edit/delete files, run commands, install packages, git, system changes

Message: """${userText}"""

Classification:`;

      const proc = spawn("claude", [
        "-p", "--model", "haiku",
        "--dangerously-skip-permissions",
        classifyPrompt,
      ], {
        cwd: config.workingDir,
        env: { ...process.env, LANG: "en_US.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let stderrOut = "";
      let settled = false;

      const ts = () => `[${new Date().toISOString()}]`;

      console.log(`${ts()} 🔍 classifier: starting haiku for "${userText.slice(0, 60)}"`);

      proc.stdout.on("data", (d) => output += d);
      proc.stderr.on("data", (d) => stderrOut += d);

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        const raw = output.trim();
        const result = raw.toUpperCase();
        const isChat = result.includes("CHAT") && !result.includes("ACTION");

        console.log(`${ts()} 🔍 classifier: exit=${code} raw="${raw}" stderr="${stderrOut.trim().slice(0, 200)}" → ${isChat ? "CHAT ✓" : "ACTION 🔐"}`);
        resolve(isChat ? "chat" : "action");
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        console.log(`${ts()} 🔍 classifier: spawn error: ${err.message} → ACTION (fallback)`);
        resolve("action");
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        console.log(`${ts()} 🔍 classifier: timeout (20s) → ACTION (fallback)`);
        resolve("action");
      }, 20000);
    });
  }

  // ── Ask for approval via Telegram before running Claude ──

  function requestApproval(chatId, userText) {
    return new Promise((resolve) => {
      const approvalId = randomUUID().slice(0, 8);
      const preview = userText.length > 200 ? userText.slice(0, 200) + "…" : userText;

      const timer = setTimeout(() => {
        if (pendingApprovals.has(approvalId)) {
          pendingApprovals.delete(approvalId);
          resolve(false);
          bot.sendMessage(chatId, msg.permTimedOut || "Auto-denied (timeout)").catch(() => {});
        }
      }, APPROVAL_TIMEOUT);

      pendingApprovals.set(approvalId, { chatId, resolve, timer });

      bot.sendMessage(chatId,
        `🔐 *${msg.permTitle || "Permission"}*\n\n${preview}\n\n${msg.permApprovalHint || "Allow Claude to use all tools for this request?"}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ ${msg.permAllow || "Allow"}`, callback_data: `approve:${approvalId}:y` },
              { text: `❌ ${msg.permDeny || "Deny"}`, callback_data: `approve:${approvalId}:n` },
            ]],
          },
        }
      ).catch(() => {
        bot.sendMessage(chatId,
          `🔐 ${msg.permTitle || "Permission"}\n\n${preview}\n\n${msg.permApprovalHint || "Allow Claude to use all tools for this request?"}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: `✅ ${msg.permAllow || "Allow"}`, callback_data: `approve:${approvalId}:y` },
                { text: `❌ ${msg.permDeny || "Deny"}`, callback_data: `approve:${approvalId}:n` },
              ]],
            },
          }
        ).catch(() => {});
      });

      console.log(`[${new Date().toISOString()}] Approval ${approvalId} sent for chat ${chatId}`);
    });
  }

  // ── Call Claude Code CLI ──

  function callClaude(prompt, chatId, skipPerms) {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
      ];
      if (skipPerms) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);
      if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);

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
      let activities = [];
      let currentTool = null;
      let currentToolName = null;
      let currentToolInput = "";
      let createdFiles = [];
      let settled = false;
      let lineBuf = "";
      let stderr = "";
      let lastActivityCount = 0;

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
        if (activities.length > 15) activities = activities.slice(-15);
      }

      function handleEvent(line) {
        if (!line.trim()) return;

        let ev;
        try { ev = JSON.parse(line); } catch { return; }

        if (ev.type === "system") {
          addActivity("⚙️", ev.message || ev.subtype || "system event");
        }

        if (ev.type === "stream_event") {
          const e = ev.event;

          if (e?.delta?.type === "text_delta" && e.delta.text) {
            resultText += e.delta.text;
            if (!currentTool) currentTool = "writing";
          }

          if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
            const name = e.content_block.name || "tool";
            currentTool = name;
            currentToolName = name;
            currentToolInput = "";
            addActivity("🔧", name);
          }

          if (e?.type === "content_block_start" && e.content_block?.type === "text") {
            currentTool = "writing";
            addActivity("✍️", "Generating text...");
          }

          if (e?.delta?.type === "input_json_delta" && e.delta.partial_json) {
            currentToolInput += e.delta.partial_json;
          }

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

        if (ev.type === "result") {
          if (ev.result) resultText = ev.result;
        }
      }

      function summarizeInput(input) {
        if (!input) return "";
        const s = JSON.stringify(input);
        return s.length > 80 ? s.slice(0, 80) + "…" : s;
      }

      const progressTimer = setInterval(() => sendProgress(), PROGRESS_INTERVAL);

      async function sendProgress() {
        if (settled) return;
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

  // ── Telegram commands ──

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

  // ── Inline keyboard callbacks ──

  bot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message?.chat?.id;
    if (!chatId || !data) return;

    // ── Approval response (per-message permission) ──
    if (data.startsWith("approve:")) {
      const [, approvalId, answer] = data.split(":");
      const pending = pendingApprovals.get(approvalId);

      if (pending) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(approvalId);

        const approved = answer === "y";
        const label = approved
          ? (msg.permAllowed || "Allowed!")
          : (msg.permDenied || "Denied!");
        const icon = approved ? "✅" : "❌";

        await bot.answerCallbackQuery(query.id, { text: label });

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: `${icon} ${label}`, callback_data: "noop" }]] },
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch {}

        pending.resolve(approved);
        console.log(`[${new Date().toISOString()}] ${query.from?.username}: approval ${approvalId} → ${answer}`);
      } else {
        await bot.answerCallbackQuery(query.id, { text: msg.permExpired || "Expired" });
      }
      return;
    }

    // ── Resume session ──
    if (!data.startsWith("resume:")) return;

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
    if (text.startsWith("/")) return;

    if (allowed.length > 0 && !allowed.includes(userId)) {
      console.log(msg.gatewayBlocked(userId, m.from?.username));
      return;
    }

    console.log(`[${new Date().toISOString()}] 📩 ${m.from?.username}: "${text}"`);

    // ── Smart approval: classify intent first, only ask for actions ──
    let skipPerms = config.skipPermissions;

    if (!skipPerms) {
      console.log(`[${new Date().toISOString()}] 🛡️  approval mode — classifying intent...`);
      const intent = await classifyIntent(text);

      if (intent === "action") {
        console.log(`[${new Date().toISOString()}] 🔐 action detected — asking user for approval`);
        const approved = await requestApproval(chatId, text);
        if (!approved) {
          console.log(`[${new Date().toISOString()}] ❌ ${m.from?.username}: denied → skipping`);
          return;
        }
        console.log(`[${new Date().toISOString()}] ✅ ${m.from?.username}: approved → running with --dangerously-skip-permissions`);
        skipPerms = true;
      } else {
        console.log(`[${new Date().toISOString()}] 💬 chat detected — running without skip-permissions`);
      }
    } else {
      console.log(`[${new Date().toISOString()}] ⚡ autonomous mode — skipping classification`);
    }

    bot.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    await withChatLock(chatId, async () => {
      try {
        const { text: response, files } = await callClaude(text, chatId, skipPerms);
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

        if (err.message && err.message.includes("session")) {
          console.log(`[${new Date().toISOString()}] Session error for chat ${chatId}, retrying fresh...`);
          clearActiveSession(chatId);
          try {
            const { text: retryResponse } = await callClaude(text, chatId, skipPerms);
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
