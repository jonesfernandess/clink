import TelegramBot from "node-telegram-bot-api";
import { spawn, execSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./config.js";
import { t } from "./i18n.js";
import { sendFile, sendText } from "./send.js";
import { getActiveSession, setActiveSession, clearActiveSession, listClaudeSessions, findSession } from "./session.js";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── Audio transcription via faster-whisper ──

async function downloadTelegramFile(bot, fileId) {
  const tmpDir = join(tmpdir(), "clink-audio");
  mkdirSync(tmpDir, { recursive: true });
  const filePath = await bot.downloadFile(fileId, tmpDir);
  return filePath;
}

function transcribeAudio(audioPath, whisperModel = "base") {
  const scriptPath = join(__dirname, "transcribe.py");
  try {
    const result = execSync(`python3 "${scriptPath}" "${audioPath}" "${whisperModel}"`, {
      encoding: "utf-8",
      timeout: 120_000,
    });
    return result.trim();
  } catch (err) {
    console.error(`Transcription failed: ${err.message}`);
    return null;
  }
}

function convertToWav(inputPath) {
  const wavPath = inputPath.replace(/\.[^.]+$/, ".wav");
  try {
    execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" 2>/dev/null`, {
      timeout: 30_000,
    });
    return wavPath;
  } catch (err) {
    console.error(`FFmpeg conversion failed: ${err.message}`);
    return null;
  }
}

function cleanupFiles(...paths) {
  for (const p of paths) {
    try { if (p && existsSync(p)) unlinkSync(p); } catch {}
  }
}

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
  const pendingApprovals = new Map(); // approvalId -> { chatId, resolve, timer }
  const chatFiles = new Map();       // chatId -> [filePath, ...] — files created in session

  const IDLE_TIMEOUT = 180_000;       // kill after 3 min without ANY stdout data
  const PROGRESS_INTERVAL = 10_000;   // send/edit progress every 10s
  const APPROVAL_TIMEOUT = 120_000;   // auto-deny after 2 min with no response

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

  // ── Intent classifier — quick haiku call to decide if approval is needed ──

  function classifyIntent(userText) {
    return new Promise((resolve) => {
      const classifyPrompt = `Classify this message. Reply with a single word: CHAT, ACTION, or SEND_FILE.

CHAT = greetings, questions, conversation, explanations (no tools needed)
ACTION = create/edit/delete files, run commands, install packages, git, system changes
SEND_FILE = user is asking to receive/send/download a file via chat (e.g. "me manda o arquivo", "send me the file", "envia o PDF")

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

        let intent;
        if (result.includes("SEND_FILE") || result.includes("SEND FILE")) {
          intent = "send_file";
        } else if (result.includes("CHAT") && !result.includes("ACTION")) {
          intent = "chat";
        } else {
          intent = "action";
        }

        const icons = { chat: "CHAT ✓", action: "ACTION 🔐", send_file: "SEND_FILE 📎" };
        console.log(`${ts()} 🔍 classifier: exit=${code} raw="${raw}" stderr="${stderrOut.trim().slice(0, 200)}" → ${icons[intent]}`);
        resolve(intent);
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

  function callClaude(prompt, chatId, skipPerms, extraSystemPrompt) {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
      ];
      if (skipPerms) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);

      // Combine user system prompt + extra (e.g. file sending instructions)
      const sysPromptParts = [config.systemPrompt, extraSystemPrompt].filter(Boolean);
      if (sysPromptParts.length > 0) {
        args.push("--append-system-prompt", sysPromptParts.join("\n\n"));
      }

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
            if (!currentTool) currentTool = "writing";
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
    chatFiles.delete(m.chat.id);
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
    let text = m.text;

    const hasAudio = m.voice || m.audio;
    if (!text && !hasAudio) return;

    // Skip commands — already handled by onText
    if (text && text.startsWith("/")) return;

    if (allowed.length > 0 && !allowed.includes(userId)) {
      console.log(msg.gatewayBlocked(userId, m.from?.username));
      return;
    }

    // ── Audio/voice transcription ──
    if (hasAudio && !text) {
      const fileId = m.voice?.file_id || m.audio?.file_id;
      const duration = m.voice?.duration || m.audio?.duration || 0;
      console.log(`[${new Date().toISOString()}] 🎤 ${m.from?.username}: voice/audio (${duration}s)`);

      await bot.sendMessage(chatId, msg.audioTranscribing || "🎤 Transcribing audio...").catch(() => {});
      bot.sendChatAction(chatId, "typing").catch(() => {});

      let downloadedPath = null;
      let wavPath = null;
      try {
        downloadedPath = await downloadTelegramFile(bot, fileId);
        wavPath = convertToWav(downloadedPath);
        if (!wavPath) {
          await bot.sendMessage(chatId, msg.audioConversionFailed || "Failed to convert audio.");
          return;
        }
        const transcribed = transcribeAudio(wavPath);
        if (!transcribed) {
          await bot.sendMessage(chatId, msg.audioTranscriptionFailed || "Failed to transcribe audio.");
          return;
        }
        text = transcribed;
        console.log(`[${new Date().toISOString()}] 🎤 transcribed: "${text.slice(0, 100)}"`);
        await bot.sendMessage(chatId, `🎤 *${msg.audioTranscription || "Transcription"}:*\n${text}`, { parse_mode: "Markdown" }).catch(
          () => bot.sendMessage(chatId, `🎤 ${msg.audioTranscription || "Transcription"}:\n${text}`)
        );
      } catch (err) {
        console.error(`Audio processing failed: ${err.message}`);
        await bot.sendMessage(chatId, msg.audioTranscriptionFailed || "Failed to transcribe audio.").catch(() => {});
        return;
      } finally {
        cleanupFiles(downloadedPath, wavPath);
      }
    }

    console.log(`[${new Date().toISOString()}] 📩 ${m.from?.username}: "${text}"`);

    // ── Smart approval: classify intent, only ask for actions ──
    let skipPerms = config.skipPermissions;
    let wantsFiles = false;

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
      } else if (intent === "send_file") {
        console.log(`[${new Date().toISOString()}] 📎 send_file detected — will deliver files after response`);
        wantsFiles = true;
        skipPerms = true; // needs tools to read/find files
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

    // Build extra system prompt for file sending and cross-chat messaging
    let extraSysPrompt = null;
    const tracked = chatFiles.get(chatId) || [];
    const fileList = tracked.length > 0
      ? tracked.map((f) => `  - ${f}`).join("\n")
      : "  (no files tracked yet)";

    const crossChatPrompt = `You are chatting via Telegram. You have the ability to send messages and files to OTHER Telegram chats (users, groups, channels).

To send a message to another chat, include this tag in your response:
[SEND_TO:<chat_id>:<message text>]

To send a file to another chat, include this tag:
[SEND_FILE_TO:<chat_id>:/absolute/path]

To send a file to another chat with a caption:
[SEND_FILE_TO:<chat_id>:/absolute/path:<caption>]

Examples:
- [SEND_TO:123456789:Hello! This is a message from the bot.]
- [SEND_TO:-1001234567890:Report ready for review.]
- [SEND_FILE_TO:123456789:/home/user/report.pdf]
- [SEND_FILE_TO:-1001234567890:/home/user/image.png:Here is the chart]

Rules:
- Group/channel IDs are negative numbers (e.g. -1001234567890). User IDs are positive.
- The user must provide the chat ID. If they don't know it, suggest they check the group/user info or forward a message from the target.
- You can send multiple tags in one response.
- Always confirm to the user what you sent and to whom.
- These tags are invisible to the user — they are parsed and executed by the system.`;

    if (wantsFiles) {
      extraSysPrompt = `${crossChatPrompt}

You can also send files to THIS chat by including [SEND_FILE:/absolute/path] tags in your response.
Only use absolute paths. You can also use Read/Glob to find files if needed.

Files created in this session:
${fileList}`;
    } else {
      extraSysPrompt = crossChatPrompt;
    }

    await withChatLock(chatId, async () => {
      try {
        const { text: response, files } = await callClaude(text, chatId, skipPerms, extraSysPrompt);
        clearInterval(typingInterval);

        if (!response) {
          await bot.sendMessage(chatId, msg.noResponse);
          return;
        }

        // Track files created/modified by Claude in this session
        if (files && files.length > 0) {
          const existing = chatFiles.get(chatId) || [];
          chatFiles.set(chatId, [...existing, ...files]);
        }

        // Parse [SEND_FILE:/path] tags from Claude's response
        const sendFileTags = [...response.matchAll(/\[SEND_FILE:([^\]]+)\]/g)].map((m) => m[1].trim());

        // Parse [SEND_TO:<chatId>:<message>] tags for cross-chat messaging
        const sendToTags = [...response.matchAll(/\[SEND_TO:(-?\d+):([^\]]+)\]/g)].map((m) => ({
          targetChatId: Number(m[1]),
          message: m[2].trim(),
        }));

        // Parse [SEND_FILE_TO:<chatId>:/path] and [SEND_FILE_TO:<chatId>:/path:<caption>] tags
        const sendFileToTags = [...response.matchAll(/\[SEND_FILE_TO:(-?\d+):([^:\]]+)(?::([^\]]*))?\]/g)].map((m) => ({
          targetChatId: Number(m[1]),
          filePath: m[2].trim(),
          caption: m[3]?.trim() || undefined,
        }));

        // Send the response text (strip all special tags so user doesn't see them)
        const cleanResponse = response
          .replace(/\[SEND_FILE:[^\]]+\]/g, "")
          .replace(/\[SEND_TO:-?\d+:[^\]]+\]/g, "")
          .replace(/\[SEND_FILE_TO:-?\d+:[^\]]+\]/g, "")
          .trim();
        if (cleanResponse) {
          const parts = splitMessage(cleanResponse);
          for (const part of parts) {
            await bot.sendMessage(chatId, part, { parse_mode: "Markdown" }).catch(
              () => bot.sendMessage(chatId, part)
            );
          }
        }

        // Deliver files that Claude requested to send (to current chat)
        for (const filePath of sendFileTags) {
          try {
            if (existsSync(filePath)) {
              await sendFile(bot, chatId, filePath);
              console.log(`[${new Date().toISOString()}] -> sent file: ${filePath}`);
            } else {
              console.log(`[${new Date().toISOString()}] -> file not found: ${filePath}`);
            }
          } catch (fileErr) {
            console.error(`Failed to send file ${filePath}:`, fileErr.message);
          }
        }

        // Deliver messages to other chats (cross-chat messaging)
        for (const { targetChatId, message } of sendToTags) {
          try {
            await sendText(bot, targetChatId, message);
            console.log(`[${new Date().toISOString()}] -> sent message to ${targetChatId}: "${message.slice(0, 60)}"`);
          } catch (sendErr) {
            console.error(`Failed to send to ${targetChatId}:`, sendErr.message);
            await bot.sendMessage(chatId, `⚠️ ${msg.sendToFailed?.(targetChatId) || `Failed to send to ${targetChatId}: ${sendErr.message}`}`).catch(() => {});
          }
        }

        // Deliver files to other chats (cross-chat file sending)
        for (const { targetChatId, filePath, caption } of sendFileToTags) {
          try {
            if (existsSync(filePath)) {
              await sendFile(bot, targetChatId, filePath, caption);
              console.log(`[${new Date().toISOString()}] -> sent file to ${targetChatId}: ${filePath}`);
            } else {
              console.log(`[${new Date().toISOString()}] -> file not found for ${targetChatId}: ${filePath}`);
              await bot.sendMessage(chatId, `⚠️ File not found: ${filePath}`).catch(() => {});
            }
          } catch (fileErr) {
            console.error(`Failed to send file to ${targetChatId}:`, fileErr.message);
            await bot.sendMessage(chatId, `⚠️ ${msg.sendToFailed?.(targetChatId) || `Failed to send file to ${targetChatId}: ${fileErr.message}`}`).catch(() => {});
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
