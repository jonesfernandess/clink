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
import { getProvider } from "./types.js";
import type { ClinkConfig, AgentResult, IntentClassification, PendingApproval, Messages } from "./types.js";
import { getAccountEnv, rotateAccount, isQuotaError, getAccountCount, getCurrentAccount, getAccountEmail } from "./accounts.js";

const __dirname = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Audio transcription via faster-whisper ──

async function downloadTelegramFile(bot: TelegramBot, fileId: string): Promise<string> {
  const tmpDir = join(tmpdir(), "clink-audio");
  mkdirSync(tmpDir, { recursive: true });
  const filePath = await bot.downloadFile(fileId, tmpDir);
  return filePath;
}

function transcribeAudio(audioPath: string, whisperModel: string = "base"): string | null {
  const scriptPath = join(__dirname, "transcribe.py");
  try {
    const result = execSync(`python3 "${scriptPath}" "${audioPath}" "${whisperModel}"`, {
      encoding: "utf-8",
      timeout: 120_000,
    });
    return result.trim();
  } catch (err) {
    console.error(`Transcription failed: ${(err as Error).message}`);
    return null;
  }
}

function convertToWav(inputPath: string): string | null {
  const wavPath = inputPath.replace(/\.[^.]+$/, ".wav");
  try {
    execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" 2>/dev/null`, {
      timeout: 30_000,
    });
    return wavPath;
  } catch (err) {
    console.error(`FFmpeg conversion failed: ${(err as Error).message}`);
    return null;
  }
}

function cleanupFiles(...paths: (string | null)[]): void {
  for (const p of paths) {
    try { if (p && existsSync(p)) unlinkSync(p); } catch {}
  }
}

export function startBot(configOverride?: ClinkConfig): TelegramBot {
  const config: ClinkConfig = configOverride || loadConfig();
  const msg: Messages = t(config.language);

  if (!config.token) {
    console.error(msg.tokenNotConfigured);
    process.exit(1);
  }

  const bot = new TelegramBot(config.token, { polling: true });
  const allowed: number[] = config.allowedUsers.map(Number);
  const startTime: number = Date.now();
  const chatLocks: Map<string, Promise<void>> = new Map();
  const pendingApprovals: Map<string, PendingApproval> = new Map();

  // ── Account rotation env helpers ──
  const claudeEnv = () => ({ ...getAccountEnv("claude"), LANG: "en_US.UTF-8" });
  const codexEnv = () => getAccountEnv("codex");

  const chatFiles: Map<number, string[]> = new Map();

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

  function formatUptime(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function withChatLock(chatId: number, fn: () => Promise<void>): Promise<void> {
    const key = String(chatId);
    const prev = chatLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    chatLocks.set(key, next);
    next.finally(() => {
      if (chatLocks.get(key) === next) chatLocks.delete(key);
    });
    return next;
  }

  // ── Intent classifier — quick call to decide if approval is needed ──
  // Uses Haiku for Claude provider, gpt-5.1-codex-mini for Codex provider

  function classifyIntent(userText: string, chatId: number): Promise<IntentClassification> {
    return new Promise((resolve) => {
      const classifyPrompt = `Classify this user message into exactly ONE category. Reply with a single word only.

CHAT = any of these:
  - Greetings, questions, conversation, explanations
  - Reading/viewing/showing file contents ("show me", "mostre", "what's in", "read")
  - Asking about something, confirming, answering questions
  - Simple responses like "yes", "no", "ok", "isso", "that one"
  - Anything that only requires READING, not modifying

ACTION = any of these:
  - Creating, editing, or writing files
  - Running shell commands, installing packages
  - Git operations, system changes
  - Anything that MODIFIES the filesystem or system state

SEARCH = user wants information that requires LIVE web search:
  - Current events, news, prices, scores, weather
  - "quanto custa", "cotação", "preço do", "valor do"
  - "quem ganhou", "resultado do jogo", "placar"
  - Questions about people, facts, dates that need up-to-date info
  - "pesquisa sobre", "busca", "search for"
  - Any question whose answer depends on real-time or recent data

SEND_FILE = user wants to RECEIVE a file attachment in the chat:
  - "me manda o arquivo", "send me the file", "envia o PDF"
  - "mande como anexo", "send as attachment"
  - File names alone when context implies they want to receive it
  - "o arquivo de ontem", "the config file", "aquele script"

When in doubt between CHAT and ACTION, choose CHAT. Only use ACTION for operations that modify something.
When in doubt between CHAT and SEARCH, choose SEARCH if the answer likely needs current/real-time data.

Message: """${userText}"""

Classification:`;

      const provider = getProvider(config.model);
      let proc;

      if (provider === "codex") {
        // Use codex with the cheapest model, resuming session for context
        const args = ["exec"];
        const activeSessionId = getActiveSession(chatId);
        if (activeSessionId) {
          args.push("resume",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-m", "gpt-5.1-codex-mini",
            activeSessionId,
            classifyPrompt,
          );
        } else {
          args.push(
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-C", config.workingDir,
            "-m", "gpt-5.1-codex-mini",
            classifyPrompt,
          );
        }
        proc = spawn("codex", args, {
          env: codexEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        proc = spawn("claude", [
          "-p", "--model", "haiku",
          "--dangerously-skip-permissions",
          classifyPrompt,
        ], {
          cwd: config.workingDir,
          env: claudeEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      }

      const classifierName = provider === "codex" ? "codex-mini" : "haiku";

      let output = "";
      let stderrOut = "";
      let settled = false;

      const ts = (): string => `[${new Date().toISOString()}]`;

      console.log(`${ts()} 🔍 classifier: starting ${classifierName} for "${userText.slice(0, 60)}"`);

      proc.stdout!.on("data", (d: Buffer) => output += d);
      proc.stderr!.on("data", (d: Buffer) => stderrOut += d);

      proc.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;

        // Extract text — Codex returns JSONL, Claude returns plain text
        let raw = output.trim();
        if (provider === "codex") {
          // Parse JSONL to find the agent_message text
          for (const line of raw.split("\n")) {
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "item.completed") {
                const item = ev.item as Record<string, unknown>;
                if (item.type === "agent_message" && item.text) {
                  raw = item.text as string;
                }
              }
            } catch {}
          }
        }
        const result = raw.toUpperCase();

        let intent: IntentClassification;
        if (result.includes("SEND_FILE") || result.includes("SEND FILE")) {
          intent = "send_file";
        } else if (result.includes("SEARCH") && !result.includes("ACTION")) {
          intent = "search";
        } else if (result.includes("CHAT") && !result.includes("ACTION")) {
          intent = "chat";
        } else {
          intent = "action";
        }

        const icons: Record<IntentClassification, string> = { chat: "CHAT ✓", action: "ACTION 🔐", send_file: "SEND_FILE 📎", search: "SEARCH 🔍" };
        console.log(`${ts()} 🔍 classifier: exit=${code} raw="${raw}" stderr="${stderrOut.trim().slice(0, 200)}" → ${icons[intent]}`);
        resolve(intent);
      });

      proc.on("error", (err: Error) => {
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

  // ── Resolve what a destructive operation will affect ──

  interface DestructivePlan {
    summary: string;   // shown to user in approval prompt
    command: string;    // exact command to execute if approved
  }

  function resolveDestructiveImpact(userText: string, chatId: number): Promise<DestructivePlan> {
    return new Promise((resolve) => {
      const resolvePrompt = `DO NOT execute anything. The user wants to perform a destructive operation. Based on the conversation history, figure out:
1. EXACTLY which files or folders will be affected — resolve any references like "this file", "those files", "esse arquivo", "esses" to their actual absolute paths
2. The EXACT shell command needed

Respond with ONLY this format — no extra text:

SUMMARY:
🗑️ Confirm removal:
- /absolute/path/to/file1
- /absolute/path/to/file2

COMMAND:
rm /absolute/path/to/file1 /absolute/path/to/file2

User request: """${userText}"""`;

      // Use --resume to access the conversation history so references like "this file" resolve correctly
      const provider = getProvider(config.model);
      const activeSessionId = getActiveSession(chatId);
      let proc;

      if (provider === "codex") {
        const args = ["exec"];
        if (activeSessionId) {
          args.push("resume",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-m", "gpt-5.1-codex-mini",
            activeSessionId,
            resolvePrompt,
          );
        } else {
          args.push(
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-C", config.workingDir,
            "-m", "gpt-5.1-codex-mini",
            resolvePrompt,
          );
        }
        proc = spawn("codex", args, {
          env: codexEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        const args = [
          "-p", "--model", "haiku",
          "--dangerously-skip-permissions",
        ];
        if (activeSessionId) {
          args.push("--resume", activeSessionId);
        }
        args.push(resolvePrompt);
        proc = spawn("claude", args, {
          cwd: config.workingDir,
          env: claudeEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      }

      let output = "";
      let settled = false;

      proc.stdout!.on("data", (d: Buffer) => output += d);

      const fallback: DestructivePlan = { summary: `🗑️ ${userText}`, command: "" };

      proc.on("close", () => {
        if (settled) return;
        settled = true;

        // Extract text — Codex returns JSONL, Claude returns plain text
        let result = output.trim();
        if (provider === "codex") {
          for (const line of result.split("\n")) {
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "item.completed") {
                const item = ev.item as Record<string, unknown>;
                if (item.type === "agent_message" && item.text) {
                  result = item.text as string;
                }
              }
            } catch {}
          }
        }

        const summaryMatch = result.match(/SUMMARY:\s*([\s\S]*?)(?=\nCOMMAND:)/i);
        const commandMatch = result.match(/COMMAND:\s*([\s\S]*?)$/i);

        if (summaryMatch && commandMatch) {
          const cmd = commandMatch[1].trim();
          resolve({
            summary: `${summaryMatch[1].trim()}\n\n⚡ ${cmd}`,
            command: cmd,
          });
        } else if (result.includes("/")) {
          resolve({ summary: result, command: "" });
        } else {
          resolve(fallback);
        }
      });

      proc.on("error", () => {
        if (settled) return;
        settled = true;
        resolve(fallback);
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        resolve(fallback);
      }, 20000);
    });
  }

  // ── Resolve what an action will do (for approval preview) ──

  interface ActionPlan {
    summary: string;
    command: string;
  }

  function resolveActionPlan(userText: string, chatId: number): Promise<ActionPlan> {
    return new Promise((resolve) => {
      const resolvePrompt = `DO NOT execute anything. The user wants to perform an action. Based on the conversation history, figure out:
1. A short description of what will happen
2. The EXACT shell command(s) or tool operations needed

Respond with ONLY this format — no extra text:

SUMMARY:
📋 Action: <short description>
⚡ <exact command>

User request: """${userText}"""`;

      const provider = getProvider(config.model);
      const activeSessionId = getActiveSession(chatId);
      let proc;

      if (provider === "codex") {
        const args = ["exec"];
        if (activeSessionId) {
          args.push("resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-m", "gpt-5.1-codex-mini", activeSessionId, resolvePrompt);
        } else {
          args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", config.workingDir, "-m", "gpt-5.1-codex-mini", resolvePrompt);
        }
        proc = spawn("codex", args, { env: codexEnv(), stdio: ["ignore", "pipe", "pipe"] });
      } else {
        const args = ["-p", "--model", "haiku", "--dangerously-skip-permissions"];
        if (activeSessionId) args.push("--resume", activeSessionId);
        args.push(resolvePrompt);
        proc = spawn("claude", args, { cwd: config.workingDir, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"] });
      }

      let output = "";
      let settled = false;
      proc.stdout!.on("data", (d: Buffer) => output += d);

      const fallback: ActionPlan = { summary: userText, command: "" };

      proc.on("close", () => {
        if (settled) return;
        settled = true;

        let result = output.trim();
        if (provider === "codex") {
          for (const line of result.split("\n")) {
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "item.completed") {
                const item = ev.item as Record<string, unknown>;
                if (item.type === "agent_message" && item.text) result = item.text as string;
              }
            } catch {}
          }
        }

        // Try to extract structured summary
        const summaryMatch = result.match(/SUMMARY:\s*([\s\S]*?)$/i);
        if (summaryMatch) {
          resolve({ summary: summaryMatch[1].trim(), command: "" });
        } else if (result.includes("⚡")) {
          resolve({ summary: result, command: "" });
        } else {
          resolve(fallback);
        }
      });

      proc.on("error", () => { if (!settled) { settled = true; resolve(fallback); } });
      setTimeout(() => { if (!settled) { settled = true; try { proc.kill(); } catch {} resolve(fallback); } }, 15000);
    });
  }

  // ── Ask for approval via Telegram before running Claude ──

  function requestApproval(chatId: number, userText: string): Promise<boolean> {
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

  // ── Core system prompt (shared by Claude and Codex) ──

  const corePrompt = `You are chatting via Telegram. Keep responses short and direct — this is a mobile chat, not a terminal.

CRITICAL RULES:
1. NEVER run "find" commands searching the entire filesystem. NEVER do global searches like "find / ..." or "find /Users ...". These are slow and wasteful.
2. If you don't know where something is (a repo, a file, a project), ASK the user. Say something like "Where is the repo? Give me the path or the GitHub URL."
3. If the user mentions a repo name, check if it exists in the current working directory first. If not, ASK — do not search.
4. Prefer quick answers: git log, gh commands, simple checks. Not filesystem scans.
5. Autonomous mode = no permission needed for tools. It does NOT mean "assume everything and go". You MUST still understand the request before acting.
6. You have access to ALL available tools. Use whatever tool is appropriate for the task. Do NOT tell the user you lack access to something — try using the tool first.
7. For questions about weather, news, current events, stock prices, or ANY real-time information: you MUST use WebSearch or WebFetch to look it up. NEVER say you don't have access to real-time data — you DO, via these tools. Use them.`;

  // ── Call Claude Code CLI ──

  function callClaude(prompt: string, chatId: number, skipPerms: boolean, extraSystemPrompt?: string | null): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
      ];
      if (skipPerms) args.push("--dangerously-skip-permissions");
      if (config.model) args.push("--model", config.model);

      // Combine core + user system prompt + extra (e.g. file sending instructions)
      const sysPromptParts = [corePrompt, config.systemPrompt, extraSystemPrompt].filter(Boolean) as string[];
      if (sysPromptParts.length > 0) {
        args.push("--append-system-prompt", sysPromptParts.join("\n\n"));
      }

      // Session management: resume active session, auto-resume last, or create new
      let activeSessionId: string | null = getActiveSession(chatId);
      if (!activeSessionId) {
        // Auto-resume most recent session if one exists
        const sessions = listClaudeSessions(config.workingDir, 1);
        if (sessions.length > 0) {
          activeSessionId = sessions[0].sessionId;
          setActiveSession(chatId, activeSessionId);
          console.log(`[${new Date().toISOString()}] 🔄 auto-resumed last session: ${activeSessionId.slice(0, 8)}`);
        }
      }
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
        env: claudeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      let activities: string[] = [];        // log of what claude is doing
      let currentTool: string | null = null;
      let currentToolName: string | null = null;
      let currentToolInput = "";
      let createdFiles: string[] = [];      // file paths from Write/Edit tool_use
      let settled = false;
      let lineBuf = "";
      let stderr = "";
      let lastActivityCount = 0;

      // ── rolling idle timeout ──
      let idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);

      function resetIdle(): void {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);
      }

      function killIdle(): void {
        if (!settled) {
          proc.kill("SIGTERM");
          cleanup();
          reject(new Error("claude timed out (no output for 3 min)"));
        }
      }

      function addActivity(text: string): void {
        activities.push(text);
        if (activities.length > 10) activities = activities.slice(-10);
      }

      // Build a human-readable description of what a tool did
      function describeToolUse(name: string, input: string): string | null {
        try {
          const parsed = typeof input === "string" ? JSON.parse(input) as unknown : input;
          const p = parsed as Record<string, unknown>;
          switch (name) {
            case "Read": {
              const file = (p.file_path as string | undefined)?.split("/").pop() || "file";
              return `📖 Reading ${file}`;
            }
            case "Edit": {
              const edited = (p.file_path as string | undefined)?.split("/").pop() || "file";
              return `✏️ Editing ${edited}`;
            }
            case "Write": {
              const written = (p.file_path as string | undefined)?.split("/").pop() || "file";
              return `📝 Writing ${written}`;
            }
            case "Bash": {
              const cmd = (p.command as string) || "";
              // "cat > /long/path/file.py" → "📝 Creating file.py"
              const catMatch = cmd.match(/^cat\s*>\s*(.+)/);
              if (catMatch) {
                const fname = catMatch[1].trim().split("/").pop()!.split("'")[0].split('"')[0].trim();
                return `📝 Creating ${fname}`;
              }
              // "git ..." → show full git command
              if (cmd.startsWith("git ")) return `⚡ ${cmd.slice(0, 80)}`;
              // "cd X && ..." → show the meaningful part
              const afterCd = cmd.match(/&&\s*(.+)/);
              if (afterCd) return `⚡ ${afterCd[1].trim().slice(0, 60)}`;
              return `⚡ ${cmd.slice(0, 60)}`;
            }
            case "Grep":
              return `🔍 Searching: ${((p.pattern as string) || "").slice(0, 40)}`;
            case "Glob":
              return `📂 Finding: ${((p.pattern as string) || "").slice(0, 40)}`;
            case "Agent":
              return `🤖 Sub-agent: ${((p.description as string) || "working").slice(0, 40)}`;
            default:
              if (/^(Task|Todo)/.test(name)) return null; // skip internal tools
              return `🔧 ${name}`;
          }
        } catch {
          return `🔧 ${name}`;
        }
      }

      // ── parse stream-json events ──
      function handleEvent(line: string): void {
        if (!line.trim()) return;

        let ev: unknown;
        try { ev = JSON.parse(line); } catch { return; }

        const event = ev as Record<string, unknown>;

        if (event.type === "stream_event") {
          const e = event.event as Record<string, unknown> | undefined;

          // text being generated
          const delta = e?.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            resultText += delta.text as string;
            if (!currentTool) currentTool = "writing";
          }

          // tool use started
          const contentBlock = e?.content_block as Record<string, unknown> | undefined;
          if (e?.type === "content_block_start" && contentBlock?.type === "tool_use") {
            const name = (contentBlock.name as string) || "tool";
            currentTool = name;
            currentToolName = name;
            currentToolInput = "";
            console.log(`[${new Date().toISOString()}] 🔧 tool: ${name}`);
          }

          // tool input — accumulate
          if (delta?.type === "input_json_delta" && delta.partial_json) {
            currentToolInput += delta.partial_json as string;
          }

          // block finished — log a readable description
          if (e?.type === "content_block_stop") {
            if (currentToolName) {
              // track created/edited files
              if (/^(Write|Edit|write|edit)$/.test(currentToolName) && currentToolInput) {
                try {
                  const input = JSON.parse(currentToolInput) as Record<string, unknown>;
                  if (input.file_path) createdFiles.push(input.file_path as string);
                } catch {}
              }
              // log tool details to terminal
              const desc = describeToolUse(currentToolName, currentToolInput);
              if (desc) {
                console.log(`[${new Date().toISOString()}]   ${desc}`);
                addActivity(desc);
              }
            }
            currentTool = null;
            currentToolName = null;
            currentToolInput = "";
          }
        }

        // final result
        if (event.type === "result") {
          const resultEvent = event as Record<string, unknown>;
          if (resultEvent.result) resultText = resultEvent.result as string;
        }
      }

      // ── periodic progress updates as new messages ──
      const progressTimer = setInterval(() => sendProgress(), PROGRESS_INTERVAL);

      async function sendProgress(): Promise<void> {
        if (settled) return;

        // only send if there are new activities
        if (activities.length === lastActivityCount) return;

        const newActivities = activities.slice(lastActivityCount);
        lastActivityCount = activities.length;

        const log = newActivities.join("\n");
        if (!log.trim()) return;

        try {
          await bot.sendMessage(chatId, log);
        } catch {}
      }

      function cleanup(): void {
        settled = true;
        clearTimeout(idleTimer);
        clearInterval(progressTimer);
      }

      // ── parse newline-delimited JSON from stdout ──
      proc.stdout!.on("data", (chunk: Buffer) => {
        resetIdle();
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop()!;
        for (const line of lines) handleEvent(line);
      });

      proc.stderr!.on("data", (d: Buffer) => {
        stderr += d;
        resetIdle();
      });

      proc.on("close", async (code: number | null) => {
        if (settled) return;
        if (lineBuf.trim()) handleEvent(lineBuf);
        cleanup();
        const finalText = resultText.trim();
        if (code === 0) {
          // Log response to terminal
          const preview = finalText.length > 500 ? finalText.slice(0, 500) + "..." : finalText;
          console.log(`[${new Date().toISOString()}] 💬 response: ${preview}`);
          resolve({ text: finalText, files: createdFiles });
        } else {
          reject(new Error(`claude exit ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      });
    });
  }

  // ── Call Codex CLI ──

  function callCodex(prompt: string, chatId: number, extraSystemPrompt?: string | null, search?: boolean): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const codexFileDeliveryReinforcement = `
CRITICAL — FILE DELIVERY VIA TELEGRAM:
You are running inside a Telegram bot. You CANNOT send files directly to the user.
The ONLY way to deliver a file is by including this exact tag in your text response:
[SEND_FILE:/absolute/path/to/file]

Example response: "Here is your file! [SEND_FILE:/Users/jones/Desktop/codex.txt]"

The bot system will parse this tag and send the file. Without it, the file will NOT arrive.
Do NOT ask the user for a chat_id. Do NOT say you can't send files. Just include the tag.
The current chat ID is: ${chatId}`;

      const fullPrompt = extraSystemPrompt
        ? `${corePrompt}\n\n${codexFileDeliveryReinforcement}\n\n${extraSystemPrompt}\n\nUser message: ${prompt}`
        : `${corePrompt}\n\n${codexFileDeliveryReinforcement}\n\nUser message: ${prompt}`;

      const args: string[] = search ? ["--search", "exec"] : ["exec"];

      // Session resume — flags must come before positional args
      const activeSessionId = getActiveSession(chatId);
      if (activeSessionId) {
        args.push("resume",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
        );
        if (config.model) args.push("-m", config.model);
        args.push(activeSessionId, fullPrompt);
      } else {
        args.push(
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "-C", config.workingDir,
        );
        if (config.model) args.push("-m", config.model);
        args.push(fullPrompt);
      }

      const proc = spawn("codex", args, {
        env: codexEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      const activities: string[] = [];
      let threadId: string | null = null;
      let lineBuf = "";
      let stderr = "";
      let settled = false;
      let lastActivityCount = 0;

      let idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);

      function resetIdle(): void {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killIdle(), IDLE_TIMEOUT);
      }

      function killIdle(): void {
        if (!settled) {
          proc.kill("SIGTERM");
          cleanup();
          reject(new Error("codex timed out (no output for 3 min)"));
        }
      }

      function handleCodexEvent(line: string): void {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;

          if (ev.type === "thread.started") {
            threadId = ev.thread_id as string;
          }

          if (ev.type === "item.completed") {
            const item = ev.item as Record<string, unknown>;
            if (item.type === "agent_message" && item.text) {
              resultText = item.text as string;
            } else if (item.type === "web_search") {
              const action = item.action as Record<string, unknown> | undefined;
              const queries = action?.queries as string[] | undefined;
              const query = (action?.query as string) || (item.query as string) || "";
              if (queries && queries.length > 0) {
                for (const q of queries) {
                  const desc = `🌐 Search: ${q.slice(0, 60)}`;
                  console.log(`[${new Date().toISOString()}] ${desc}`);
                  activities.push(desc);
                  if (activities.length > 10) activities.splice(0, activities.length - 10);
                }
              } else if (query) {
                const desc = `🌐 Search: ${query.slice(0, 60)}`;
                console.log(`[${new Date().toISOString()}] ${desc}`);
                activities.push(desc);
                if (activities.length > 10) activities.splice(0, activities.length - 10);
              }
            } else if (item.type === "command_execution") {
              const cmd = (item.command as string) || "";
              // Extract the actual command from shell wrapper
              const innerMatch = cmd.match(/"([^"]+)"/);
              const displayCmd = innerMatch ? innerMatch[1] : cmd;
              const shortCmd = displayCmd.length > 80 ? displayCmd.slice(0, 80) + "..." : displayCmd;
              console.log(`[${new Date().toISOString()}] ⚡ codex: ${shortCmd}`);
              activities.push(`⚡ ${shortCmd}`);
              if (activities.length > 10) activities.splice(0, activities.length - 10);
            }
          }

          if (ev.type === "item.started") {
            const item = ev.item as Record<string, unknown>;
            if (item.type === "command_execution") {
              console.log(`[${new Date().toISOString()}] 🔧 codex running command...`);
            } else if (item.type === "web_search") {
              console.log(`[${new Date().toISOString()}] 🌐 searching the web...`);
              activities.push("🌐 Searching the web...");
              if (activities.length > 10) activities.splice(0, activities.length - 10);
            }
          }

          if (ev.type === "turn.completed") {
            const usage = ev.usage as Record<string, unknown> | undefined;
            if (usage) {
              console.log(`[${new Date().toISOString()}] 📊 tokens: ${usage.input_tokens}in/${usage.output_tokens}out`);
            }
          }
        } catch {}
      }

      // Progress updates
      const progressTimer = setInterval(async () => {
        if (settled) return;
        if (activities.length === lastActivityCount) return;
        const newActs = activities.slice(lastActivityCount);
        lastActivityCount = activities.length;
        const log = newActs.join("\n");
        if (log.trim()) {
          try { await bot.sendMessage(chatId, log); } catch {}
        }
      }, PROGRESS_INTERVAL);

      function cleanup(): void {
        settled = true;
        clearTimeout(idleTimer);
        clearInterval(progressTimer);
      }

      proc.stdout!.on("data", (chunk: Buffer) => {
        resetIdle();
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop()!;
        for (const line of lines) handleCodexEvent(line);
      });

      proc.stderr!.on("data", (d: Buffer) => {
        stderr += d;
        resetIdle();
      });

      proc.on("close", (code: number | null) => {
        if (settled) return;
        if (lineBuf.trim()) handleCodexEvent(lineBuf);
        cleanup();

        // Save Codex session for resume
        if (threadId) {
          setActiveSession(chatId, threadId);
        }

        if (code === 0 || resultText.trim()) {
          const finalText = resultText.trim();
          const preview = finalText.length > 500 ? finalText.slice(0, 500) + "..." : finalText;
          console.log(`[${new Date().toISOString()}] 💬 response: ${preview}`);
          resolve({ text: finalText, files: [] });
        } else {
          reject(new Error(`codex exit ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      });
    });
  }

  function splitMessage(text: string, maxLen: number = 4000): string[] {
    const parts: string[] = [];
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

  function isAllowed(m: TelegramBot.Message): boolean {
    const userId = m.from?.id;
    if (allowed.length > 0 && !allowed.includes(userId!)) {
      console.log(msg.gatewayBlocked(userId!, m.from?.username || ""));
      return false;
    }
    return true;
  }

  bot.onText(/\/start$/, async (m: TelegramBot.Message) => {
    if (!isAllowed(m)) return;
    await bot.sendMessage(m.chat.id, msg.botWelcome);
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /start`);
  });

  bot.onText(/\/new$/, async (m: TelegramBot.Message) => {
    if (!isAllowed(m)) return;
    clearActiveSession(m.chat.id);
    chatFiles.delete(m.chat.id);
    await bot.sendMessage(m.chat.id, msg.sessionCleared);
    console.log(`[${new Date().toISOString()}] ${m.from?.username}: /new (session cleared)`);
  });

  bot.onText(/\/status$/, async (m: TelegramBot.Message) => {
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

  bot.onText(/\/sessions$/, async (m: TelegramBot.Message) => {
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

  bot.on("callback_query", async (query: TelegramBot.CallbackQuery) => {
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
            { chat_id: chatId, message_id: query.message!.message_id }
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

  bot.on("message", async (m: TelegramBot.Message) => {
    const chatId = m.chat.id;
    const userId = m.from?.id;
    let text = m.text;

    const hasAudio = m.voice || m.audio;
    if (!text && !hasAudio) return;

    // Skip commands — already handled by onText
    if (text && text.startsWith("/")) return;

    if (allowed.length > 0 && !allowed.includes(userId!)) {
      console.log(msg.gatewayBlocked(userId!, m.from?.username || ""));
      return;
    }

    // ── Audio/voice transcription ──
    if (hasAudio && !text) {
      const fileId = m.voice?.file_id || m.audio?.file_id;
      const duration = m.voice?.duration || m.audio?.duration || 0;
      console.log(`[${new Date().toISOString()}] 🎤 ${m.from?.username}: voice/audio (${duration}s)`);

      await bot.sendMessage(chatId, msg.audioTranscribing || "🎤 Transcribing audio...").catch(() => {});
      bot.sendChatAction(chatId, "typing").catch(() => {});

      let downloadedPath: string | null = null;
      let wavPath: string | null = null;
      try {
        downloadedPath = await downloadTelegramFile(bot, fileId!);
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
      } catch (err) {
        console.error(`Audio processing failed: ${(err as Error).message}`);
        await bot.sendMessage(chatId, msg.audioTranscriptionFailed || "Failed to transcribe audio.").catch(() => {});
        return;
      } finally {
        cleanupFiles(downloadedPath, wavPath);
      }
    }

    console.log(`[${new Date().toISOString()}] 📩 ${m.from?.username}: "${text}"`);

    // Typing indicator — send immediately so user sees feedback
    bot.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    // ── Destructive operation guard — always confirm deletions ──
    const destructivePattern = /\b(rm\s|rm\b|remov|delet|apag|exclu|elimin|drop\s|drop\b|wipe|limpar|borrar|format)/i;
    const isDestructive = destructivePattern.test(text!);

    // ── Smart approval: classify intent, only ask for actions ──
    let skipPerms: boolean = config.skipPermissions;
    let wantsFiles = false;
    let wantsSearch = false;

    if (isDestructive) {
      console.log(`[${new Date().toISOString()}] 🗑️  destructive operation detected — resolving targets...`);
      const plan = await resolveDestructiveImpact(text!, chatId);
      const approved: boolean = await requestApproval(chatId, plan.summary);
      if (!approved) {
        console.log(`[${new Date().toISOString()}] ❌ ${m.from?.username}: denied destructive operation`);
        return;
      }
      console.log(`[${new Date().toISOString()}] ✅ ${m.from?.username}: approved destructive operation`);
      // Override the prompt with the pre-approved command so Sonnet executes exactly what was shown
      if (plan.command) {
        text = `Execute EXACTLY this command, nothing else: ${plan.command}`;
        console.log(`[${new Date().toISOString()}] 🔒 using pre-approved command: ${plan.command}`);
      }
      skipPerms = true;
    } else if (!skipPerms) {
      console.log(`[${new Date().toISOString()}] 🛡️  approval mode — classifying intent...`);
      const intent: IntentClassification = await classifyIntent(text!, chatId);

      if (intent === "action") {
        console.log(`[${new Date().toISOString()}] 🔐 action detected — resolving plan for approval...`);
        const actionPlan = await resolveActionPlan(text!, chatId);
        const approved: boolean = await requestApproval(chatId, actionPlan.summary);
        if (!approved) {
          console.log(`[${new Date().toISOString()}] ❌ ${m.from?.username}: denied → skipping`);
          return;
        }
        console.log(`[${new Date().toISOString()}] ✅ ${m.from?.username}: approved → running with --dangerously-skip-permissions`);
        if (actionPlan.command) {
          text = `Execute EXACTLY this command, nothing else: ${actionPlan.command}`;
          console.log(`[${new Date().toISOString()}] 🔒 using pre-approved command: ${actionPlan.command}`);
        }
        skipPerms = true;
      } else if (intent === "search") {
        console.log(`[${new Date().toISOString()}] 🔍 search detected — enabling web search tool`);
        wantsSearch = true;
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

    // Build extra system prompt for file sending and cross-chat messaging
    let extraSysPrompt: string | null = null;
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

⚠️ FILE DELIVERY INSTRUCTIONS (MANDATORY):
The user wants to RECEIVE a file in this Telegram chat.
You are NOT able to send files directly. The ONLY way to deliver a file is by including a special tag in your text response.

REQUIRED STEPS:
1. Use Read/Glob tools to find the file and confirm its absolute path
2. Include the tag [SEND_FILE:/absolute/path/to/file] in your response
3. The system will parse this tag and send the file to Telegram

RULES:
- Without [SEND_FILE:...] the file will NOT be delivered, no matter what you say
- Saying 'Enviado', 'Sent', or 'Here is the file' does NOTHING without the tag
- You MUST use the exact format: [SEND_FILE:/absolute/path]
- Example: 'Here is your file! [SEND_FILE:/Users/jones/Desktop/test2.txt]'

Files created in this session:
${fileList}`;
    } else {
      extraSysPrompt = crossChatPrompt;
    }

    await withChatLock(chatId, async () => {
      const provider = getProvider(config.model);
      try {
        const { text: response, files } = provider === "codex"
          ? await callCodex(text!, chatId, extraSysPrompt, wantsSearch)
          : await callClaude(text!, chatId, skipPerms, extraSysPrompt);
        clearInterval(typingInterval);

        if (wantsFiles) {
          console.log(`[${new Date().toISOString()}] 📎 raw response: "${response.slice(0, 300)}"`);
          console.log(`[${new Date().toISOString()}] 📎 tracked files: ${JSON.stringify(chatFiles.get(chatId) || [])}`);
          console.log(`[${new Date().toISOString()}] 📎 created files: ${JSON.stringify(files || [])}`);
        }

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
        // Also handle wrong format [SEND_FILE:chatid:/path] where Claude mixed up SEND_FILE and SEND_FILE_TO
        const sendFileTags = [...response.matchAll(/\[SEND_FILE:([^\]]+)\]/g)].map((match) => {
          const raw = match[1].trim();
          const parts = raw.split(":");
          if (parts.length >= 2 && /^-?\d+$/.test(parts[0].trim()) && parts[1].startsWith("/")) {
            return parts.slice(1).join(":").trim();
          }
          return raw;
        });

        // Parse [SEND_TO:<chatId>:<message>] tags for cross-chat messaging
        const sendToTags = [...response.matchAll(/\[SEND_TO:(-?\d+):([^\]]+)\]/g)].map((match) => ({
          targetChatId: Number(match[1]),
          message: match[2].trim(),
        }));

        // Parse [SEND_FILE_TO:<chatId>:/path] and [SEND_FILE_TO:<chatId>:/path:<caption>] tags
        const sendFileToTags = [...response.matchAll(/\[SEND_FILE_TO:(-?\d+):([^:\]]+)(?::([^\]]*))?\]/g)].map((match) => ({
          targetChatId: Number(match[1]),
          filePath: match[2].trim(),
          caption: match[3]?.trim() || undefined,
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

        // Warn if Claude failed to include SEND_FILE tag
        if (wantsFiles && sendFileTags.length === 0 && sendFileToTags.length === 0) {
          console.log(`[${new Date().toISOString()}] ⚠️ wantsFiles=true but no SEND_FILE tags in response`);
          await bot.sendMessage(chatId,
            msg.fileNotDelivered || "⚠️ Claude did not deliver the file. Try being more specific, e.g.: \"send me /Users/jones/Desktop/test2.txt\""
          );
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
            console.error(`Failed to send file ${filePath}:`, (fileErr as Error).message);
          }
        }

        // Deliver messages to other chats (cross-chat messaging)
        for (const { targetChatId, message } of sendToTags) {
          try {
            await sendText(bot, targetChatId, message);
            console.log(`[${new Date().toISOString()}] -> sent message to ${targetChatId}: "${message.slice(0, 60)}"`);
          } catch (sendErr) {
            console.error(`Failed to send to ${targetChatId}:`, (sendErr as Error).message);
            await bot.sendMessage(chatId, `⚠️ ${msg.sendToFailed?.(targetChatId) || `Failed to send to ${targetChatId}: ${(sendErr as Error).message}`}`).catch(() => {});
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
            console.error(`Failed to send file to ${targetChatId}:`, (fileErr as Error).message);
            await bot.sendMessage(chatId, `⚠️ ${msg.sendToFailed?.(targetChatId) || `Failed to send file to ${targetChatId}: ${(fileErr as Error).message}`}`).catch(() => {});
          }
        }

        console.log(`[${new Date().toISOString()}] -> replied (${response.length} chars)`);
      } catch (err) {
        clearInterval(typingInterval);
        const errMsg = (err as Error).message || "";
        console.error("Error:", errMsg);

        // Quota error → try remaining accounts round-robin
        if (isQuotaError(errMsg) && getAccountCount(provider) > 1) {
          const totalAccounts = getAccountCount(provider);
          let rotated = false;

          for (let attempt = 1; attempt < totalAccounts; attempt++) {
            const prev = getCurrentAccount(provider);
            const next = rotateAccount(provider);
            if (!next) break;

            const prevName = getAccountEmail(prev!) || prev?.label || prev?.id || "?";
            const nextName = getAccountEmail(next) || next.label || next.id;
            console.log(`[${new Date().toISOString()}] Quota hit on "${prevName}". Trying "${nextName}" (${attempt}/${totalAccounts - 1})`);
            await bot.sendMessage(chatId, msg.accountRotated(prevName, nextName)).catch(() => {});
            clearActiveSession(chatId);

            try {
              const { text: retryResponse } = provider === "codex"
                ? await callCodex(text!, chatId)
                : await callClaude(text!, chatId, skipPerms);
              if (retryResponse) {
                const parts = splitMessage(retryResponse);
                for (const part of parts) {
                  await bot.sendMessage(chatId, part, { parse_mode: "Markdown" }).catch(
                    () => bot.sendMessage(chatId, part)
                  );
                }
                console.log(`[${new Date().toISOString()}] -> rotation retry replied (${retryResponse.length} chars)`);
                rotated = true;
                break;
              }
            } catch (retryErr) {
              const retryErrMsg = (retryErr as Error).message || "";
              console.error("Rotation retry error:", retryErrMsg);
              if (!isQuotaError(retryErrMsg)) break; // non-quota error, stop trying
            }
          }

          if (!rotated) {
            // Advance pointer so next message starts on the account that's had the most time to reset
            rotateAccount(provider);
            await bot.sendMessage(chatId, msg.accountAllExhausted).catch(() => {});
          }
          return;
        }

        // Session error recovery: if resume failed, clear session and retry
        if (errMsg.includes("session")) {
          console.log(`[${new Date().toISOString()}] Session error for chat ${chatId}, retrying fresh...`);
          clearActiveSession(chatId);
          try {
            const { text: retryResponse } = provider === "codex"
              ? await callCodex(text!, chatId)
              : await callClaude(text!, chatId, skipPerms);
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
            console.error("Retry error:", (retryErr as Error).message);
          }
          await bot.sendMessage(chatId, msg.sessionRetry);
        } else {
          await bot.sendMessage(chatId, `Error: ${errMsg}`);
        }
      }
    });
  });

  bot.on("polling_error", (err: Error) => {
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
