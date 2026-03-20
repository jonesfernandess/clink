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

  const IDLE_TIMEOUT = 180_000;       // kill after 3 min without ANY stdout data
  const PROGRESS_INTERVAL = 10_000;   // send/edit progress every 10s

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
      args.push(prompt);

      const proc = spawn("claude", args, {
        cwd: config.workingDir,
        env: { ...process.env, LANG: "en_US.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      let activities = [];        // log of what claude is doing
      let currentTool = null;
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
            addActivity("🔧", name);
          }

          // text block started
          if (e?.type === "content_block_start" && e.content_block?.type === "text") {
            currentTool = "writing";
            addActivity("✍️", "Generating text...");
          }

          // tool input (shows what's being done)
          if (e?.delta?.type === "input_json_delta" && e.delta.partial_json) {
            // we could parse tool args but just note activity
          }

          // block finished
          if (e?.type === "content_block_stop") {
            currentTool = null;
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
        if (code === 0) resolve(resultText.trim());
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
      const response = await callClaude(text, chatId);
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
