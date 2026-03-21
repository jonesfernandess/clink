#!/usr/bin/env node

import * as p from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import { loadConfig, saveConfig, CONFIG_FILE } from "./config.js";
import { startBot } from "./bot.js";
import { createBot, sendText, sendFile } from "./send.js";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { t, LANGUAGE_NAMES } from "./i18n.js";
import { runWizard } from "./wizard.js";
import { listClaudeSessions } from "./session.js";
import type { ClinkConfig, Messages, GatewayStatus, SupportedLanguage } from "./types.js";

const accent = chalk.hex("#FF5A2D");
const dim = chalk.dim;
const ccGradient = gradient(["#FF5A2D", "#FF8C42", "#FFD700"]);

const PID_FILE = join(homedir(), ".config", "clink", "gateway.pid");

// ── PID helpers ──

function savePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

function readPid(): number | null {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function isRunning(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getGatewayStatus(): GatewayStatus {
  const pid = readPid();
  if (pid && isRunning(pid)) return { running: true, pid };
  if (pid) clearPid(); // stale pid
  return { running: false, pid: null };
}

// ── Banner ──

function showBanner(): void {
  const banner = figlet.textSync("CLINK", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted",
  });
  console.log("");
  console.log(ccGradient(banner));
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  console.log(`  ${accent("●")} ${chalk.bold.white("CLINK")}  ${dim("— Claude & Codex via Telegram")}`);
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
}

function maskToken(token: string, msg: Messages): string {
  if (!token) return chalk.red(msg.notConfigured);
  return chalk.green(token.slice(0, 6) + "..." + token.slice(-4));
}

function statusBar(config: ClinkConfig, msg: Messages): void {
  const gw = getGatewayStatus();
  const gwStatus = gw.running
    ? chalk.green(`● ${msg.running}`) + dim(` (pid ${gw.pid})`)
    : chalk.red(`○ ${msg.stopped}`);

  const lines = [
    "",
    `  ${dim(msg.gateway.padEnd(14))} ${gwStatus}`,
    `  ${dim(msg.token.padEnd(14))} ${maskToken(config.token, msg)}`,
    `  ${dim(msg.model.padEnd(14))} ${accent(config.model || "sonnet")}`,
    `  ${dim(msg.directory.padEnd(14))} ${chalk.blue(config.workingDir || homedir())}`,
    `  ${dim(msg.users.padEnd(14))} ${config.allowedUsers.length > 0 ? chalk.white(config.allowedUsers.join(", ")) : dim(msg.allUsers)}`,
    `  ${dim(msg.permissions.padEnd(14))} ${config.skipPermissions ? chalk.yellow(msg.autonomous) : chalk.cyan(msg.askApproval)}`,
    `  ${dim(msg.sysPrompt.padEnd(14))} ${config.systemPrompt ? chalk.white(config.systemPrompt.slice(0, 40) + "...") : dim(msg.none)}`,
    `  ${dim(msg.language.padEnd(14))} ${chalk.white(LANGUAGE_NAMES[config.language] || "English")}`,
    "",
  ];
  console.log(lines.join("\n"));
}

// ── Menu ──

async function mainMenu(): Promise<void> {
  const config = loadConfig();
  const msg = t(config.language);

  console.clear();
  showBanner();
  statusBar(config, msg);

  const gw = getGatewayStatus();

  const options: Array<{ value: string; label: string; hint?: string }> = [];
  if (gw.running) {
    options.push({ value: "stop", label: `${chalk.red("■")} Stop gateway`, hint: `pid ${gw.pid}` });
    options.push({ value: "restart", label: `${chalk.yellow("↻")} Restart gateway` });
    options.push({ value: "status", label: `${chalk.blue("i")} Gateway status` });
  } else {
    options.push({ value: "start", label: `${chalk.green("▶")} ${msg.menuStart}`, hint: config.token ? msg.ready : msg.configureTokenFirst });
  }

  options.push(
    { value: "token", label: msg.menuToken, hint: config.token ? maskToken(config.token, msg) : msg.required },
    { value: "model", label: msg.menuModel, hint: config.model || "sonnet" },
    { value: "workdir", label: msg.menuWorkdir, hint: config.workingDir || homedir() },
    { value: "users", label: msg.menuUsers, hint: config.allowedUsers.length > 0 ? msg.userCount(config.allowedUsers.length) : msg.allUsers },
    { value: "permissions", label: msg.menuPermissions, hint: config.skipPermissions ? msg.autonomous : msg.askApproval },
    { value: "prompt", label: msg.menuPrompt, hint: config.systemPrompt ? msg.configured : msg.none },
    { value: "language", label: msg.menuLanguage, hint: LANGUAGE_NAMES[config.language] || "English" },
    { value: "exit", label: `${chalk.red("✕")} ${msg.menuExit}` },
  );

  const action = await p.select({ message: msg.menuTitle, options });

  if (p.isCancel(action)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  const val = action as string;

  switch (val) {
    case "start": return handleStart(config, msg);
    case "stop": return handleStop(msg);
    case "restart": return handleRestart(config, msg);
    case "status": return handleStatus(config, msg);
    case "token": return handleToken(config, msg);
    case "model": return handleModel(config, msg);
    case "workdir": return handleWorkdir(config, msg);
    case "users": return handleUsers(config, msg);
    case "permissions": return handlePermissions(config, msg);
    case "prompt": return handlePrompt(config, msg);
    case "language": return handleLanguage(config, msg);
    case "exit":
      p.outro(dim(msg.goodbye));
      process.exit(0);
  }
}

// ── Handlers ──

function launchGateway(config: ClinkConfig, msg: Messages): void {
  p.outro(accent.bold(msg.startingGateway));
  console.log("");
  startBot(config);
  savePid(process.pid);

  process.on("SIGINT", () => {
    clearPid();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearPid();
    process.exit(0);
  });
}

async function handleStart(config: ClinkConfig, msg: Messages): Promise<void> {
  if (!config.token) {
    p.log.error(msg.configureTokenFirst);
    return mainMenu();
  }

  if (config.allowedUsers.length === 0) {
    const proceed = await p.confirm({
      message: chalk.yellow(msg.noUsersWarning),
    });
    if (p.isCancel(proceed) || !proceed) return mainMenu();
  }

  launchGateway(config, msg);
}

async function handleStop(msg: Messages): Promise<void> {
  const { pid } = getGatewayStatus();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      clearPid();
      p.log.success("Gateway stopped (pid " + pid + ")");
    } catch {
      clearPid();
      p.log.warn("Gateway process not found — cleared stale pid");
    }
  } else {
    p.log.info("Gateway is not running");
  }
  return mainMenu();
}

async function handleRestart(config: ClinkConfig, msg: Messages): Promise<void> {
  const { pid } = getGatewayStatus();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    clearPid();
    p.log.info("Previous gateway stopped (pid " + pid + ")");
  }

  // Small delay to let the port release
  await new Promise((r) => setTimeout(r, 500));

  launchGateway(config, msg);
}

async function handleStatus(config: ClinkConfig, msg: Messages): Promise<void> {
  const gw = getGatewayStatus();
  console.log("");
  if (gw.running) {
    p.log.success(`Gateway ${chalk.green(msg.running)} — pid ${gw.pid}`);
    p.log.info(`${msg.gatewayModel}: ${accent(config.model || "sonnet")}`);
    p.log.info(`${msg.gatewayDirectory}: ${chalk.blue(config.workingDir)}`);
    p.log.info(`${msg.gatewayPermissions}: ${config.skipPermissions ? msg.autonomous : msg.askApproval}`);
    p.log.info(`${msg.gatewayAllowed}: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : msg.allUsers}`);
    p.log.info(`Sessions: ${accent(String(listClaudeSessions(config.workingDir).length))}`);
  } else {
    p.log.info(`Gateway ${chalk.red(msg.stopped)}`);
  }
  console.log("");

  await p.select({
    message: "",
    options: [{ value: "back", label: msg.back }],
  });
  return mainMenu();
}

async function handleToken(config: ClinkConfig, msg: Messages): Promise<void> {
  const token = await p.text({
    message: msg.tokenPrompt,
    placeholder: msg.tokenPlaceholder,
    initialValue: config.token || "",
    validate: (v) => {
      if (!v || !v.trim()) return msg.tokenRequired;
      if (!v.includes(":")) return msg.tokenInvalid;
    },
  });

  if (p.isCancel(token)) return mainMenu();

  const val = token as string;
  config.token = val.trim();
  saveConfig(config);
  p.log.success(msg.tokenSaved);
  return mainMenu();
}

async function handleModel(config: ClinkConfig, msg: Messages): Promise<void> {
  // Check if codex CLI is available
  let hasCodex = false;
  try {
    execSync("which codex", { encoding: "utf-8", stdio: "pipe" });
    hasCodex = true;
  } catch {}

  const options: Array<{ value: string; label: string; hint?: string }> = [
    // Claude models
    { value: "sonnet", label: "Sonnet", hint: `(claude-cli) ${msg.sonnetHint}` },
    { value: "opus", label: "Opus", hint: `(claude-cli) ${msg.opusHint}` },
    { value: "haiku", label: "Haiku", hint: `(claude-cli) ${msg.haikuHint}` },
    // Codex models
    { value: "gpt-5.4", label: "GPT-5.4", hint: hasCodex ? `(codex-cli) ${msg.codexLatestHint}` : msg.codexNotFound },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: hasCodex ? `(codex-cli) ${msg.codexMiniHint}` : msg.codexNotFound },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", hint: hasCodex ? `(codex-cli) ${msg.codexCodingHint}` : msg.codexNotFound },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", hint: hasCodex ? `(codex-cli) ${msg.codexFrontierHint}` : msg.codexNotFound },
    { value: "gpt-5.2", label: "GPT-5.2", hint: hasCodex ? `(codex-cli) ${msg.codexProHint}` : msg.codexNotFound },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", hint: hasCodex ? `(codex-cli) ${msg.codexMaxHint}` : msg.codexNotFound },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", hint: hasCodex ? `(codex-cli) ${msg.codexLiteHint}` : msg.codexNotFound },
  ];

  const model = await p.select({
    message: msg.modelPrompt,
    options,
    initialValue: config.model || "sonnet",
  });

  if (p.isCancel(model)) return mainMenu();

  const val = model as string;

  // Block selection if codex not installed
  if (val.startsWith("gpt-") && !hasCodex) {
    p.log.error(msg.codexNotFound + " — install: npm i -g @openai/codex");
    return mainMenu();
  }

  config.model = val as ClinkConfig["model"];
  saveConfig(config);
  p.log.success(msg.modelChanged(accent(val)));
  return mainMenu();
}

async function handleWorkdir(config: ClinkConfig, msg: Messages): Promise<void> {
  const workdir = await p.text({
    message: msg.workdirPrompt,
    placeholder: homedir(),
    initialValue: config.workingDir || homedir(),
  });

  if (p.isCancel(workdir)) return mainMenu();

  const val = workdir as string;
  const dir = val.replace(/^~/, homedir()).trim();
  if (!existsSync(dir)) {
    p.log.error(msg.workdirNotFound(dir));
  } else {
    config.workingDir = dir;
    saveConfig(config);
    p.log.success(msg.workdirChanged(chalk.blue(dir)));
  }
  return mainMenu();
}

async function handleUsers(config: ClinkConfig, msg: Messages): Promise<void> {
  if (config.allowedUsers.length > 0) {
    p.log.info(msg.currentUsers(chalk.white(config.allowedUsers.join(", "))));
  } else {
    p.log.info(dim(msg.noUsersConfigured));
  }
  p.log.message(dim(msg.userIdHint));

  const action = await p.select({
    message: msg.manageUsers,
    options: [
      { value: "add", label: msg.addUser },
      { value: "remove", label: msg.removeUser, hint: config.allowedUsers.length === 0 ? msg.listEmpty : undefined },
      { value: "clear", label: msg.clearAll, hint: msg.allowAnyone },
      { value: "back", label: msg.back },
    ],
  });

  if (p.isCancel(action)) return mainMenu();

  const val = action as string;

  if (val === "back") return mainMenu();

  if (val === "add") {
    const userId = await p.text({
      message: msg.userIdPrompt,
      placeholder: msg.userIdPlaceholder,
      validate: (v) => {
        if (!v || !v.trim() || isNaN(Number(v.trim()))) return msg.userIdInvalid;
      },
    });
    if (!p.isCancel(userId)) {
      const userVal = userId as string;
      const id = Number(userVal.trim());
      if (!config.allowedUsers.includes(id)) {
        config.allowedUsers.push(id);
        saveConfig(config);
        p.log.success(msg.userAdded(accent(id)));
      } else {
        p.log.warn(msg.userAlreadyExists);
      }
    }
  } else if (val === "remove" && config.allowedUsers.length > 0) {
    const removeWhich = await p.select({
      message: msg.removeWhich,
      options: config.allowedUsers.map((u) => ({ value: u, label: String(u) })),
    });
    if (!p.isCancel(removeWhich)) {
      const removeVal = removeWhich as number;
      config.allowedUsers = config.allowedUsers.filter((u) => u !== removeVal);
      saveConfig(config);
      p.log.success(msg.userRemoved(removeVal));
    }
  } else if (val === "clear") {
    const confirm = await p.confirm({ message: msg.clearConfirm });
    if (!p.isCancel(confirm) && confirm) {
      config.allowedUsers = [];
      saveConfig(config);
      p.log.success(msg.listCleared);
    }
  }

  return mainMenu();
}

async function handlePermissions(config: ClinkConfig, msg: Messages): Promise<void> {
  p.log.message(
    config.skipPermissions
      ? chalk.yellow(msg.permCurrentAuto)
      : chalk.cyan(msg.permCurrentSafe)
  );

  const skip = await p.select({
    message: msg.permPrompt,
    options: [
      { value: true, label: msg.permAutoLabel, hint: msg.permAutoHint },
      { value: false, label: msg.permSafeLabel, hint: msg.permSafeHint },
    ],
    initialValue: config.skipPermissions,
  });

  if (p.isCancel(skip)) return mainMenu();

  const val = skip as boolean;
  config.skipPermissions = val;
  saveConfig(config);

  if (val) {
    p.log.success(msg.permAutoEnabled);
    p.log.warn(dim(msg.permAutoNote));
  } else {
    p.log.success(msg.permSafeEnabled);
    p.log.warn(dim(msg.permSafeNote));
  }

  return mainMenu();
}

async function handlePrompt(config: ClinkConfig, msg: Messages): Promise<void> {
  const prompt = await p.text({
    message: msg.promptMessage,
    placeholder: msg.promptPlaceholder,
    initialValue: config.systemPrompt || "",
  });

  if (p.isCancel(prompt)) return mainMenu();

  const val = prompt as string;
  config.systemPrompt = val.trim();
  saveConfig(config);
  p.log.success(config.systemPrompt ? msg.promptSaved : msg.promptRemoved);
  return mainMenu();
}

async function handleLanguage(config: ClinkConfig, msg: Messages): Promise<void> {
  const lang = await p.select({
    message: msg.languagePrompt,
    options: Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label })),
    initialValue: config.language || "en",
  });

  if (p.isCancel(lang)) return mainMenu();

  const val = lang as SupportedLanguage;
  config.language = val;
  saveConfig(config);

  const newMsg = t(val);
  p.log.success(newMsg.languageChanged(LANGUAGE_NAMES[val]));
  return mainMenu();
}

// ── Help ──

function showHelp(): void {
  console.log("");
  console.log(chalk.bold("  Usage:") + "  clink <command>");
  console.log("");
  console.log("  Commands:");
  console.log(`    ${accent("gateway")}     Start the gateway (foreground)`);
  console.log(`    ${accent("start")}       Alias for gateway`);
  console.log(`    ${accent("stop")}        Stop a running gateway`);
  console.log(`    ${accent("restart")}     Restart the gateway`);
  console.log(`    ${accent("status")}      Show gateway status`);
  console.log(`    ${accent("send")}        Send a message or file to Telegram`);
  console.log(`    ${accent("onboard")}     Run the setup wizard`);
  console.log(`    ${accent("update")}      Update to latest version from main`);
  console.log(`    ${accent("help")}        Show this help`);
  console.log("");
  console.log("  Send examples:");
  console.log(`    clink send "hello"              Send text`);
  console.log(`    clink send -f /path/file.png    Send a file`);
  console.log(`    clink send -f /path/f.pdf "lg"  File with caption`);
  console.log(`    clink send --to 123456 "hi"       Send to a specific user/DM`);
  console.log(`    clink send --to-group 123 "hi"    Send to a group/channel`);
  console.log(`    clink send                      Interactive mode`);
  console.log("");
  console.log("  Audio transcription (voice messages):");
  console.log(`    Requires: ${accent("python3")}, ${accent("faster-whisper")}, ${accent("ffmpeg")}`);
  console.log(`    pip3 install faster-whisper`);
  console.log("");
  console.log("  Run without arguments to open the interactive menu.");
  console.log("");
}

// ── Auto-update ──

function getRepoDir(): string {
  const dir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  // When running from dist/, go up one level to the project root
  if (dir.endsWith("/dist")) return dir.replace(/\/dist$/, "");
  return dir;
}

function updateFromMain(): void {
  const repoDir = getRepoDir();
  console.log("");
  console.log(`  ${accent("●")} Updating clink from ${chalk.blue("main")}...`);
  console.log(dim(`  ${repoDir}`));
  console.log("");

  try {
    execSync("git fetch origin main", { cwd: repoDir, stdio: "inherit" });
    const status = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" }).trim();
    if (status) {
      console.log(chalk.yellow("\n  ⚠ You have local changes. Stashing before update...\n"));
      execSync("git stash", { cwd: repoDir, stdio: "inherit" });
    }
    execSync("git pull origin main", { cwd: repoDir, stdio: "inherit" });
    console.log("");
    console.log(`  ${accent("●")} Installing dependencies...`);
    console.log("");
    execSync("npm install", { cwd: repoDir, stdio: "inherit" });
    console.log("");
    console.log(`  ${accent("●")} Building TypeScript...`);
    console.log("");
    execSync("npm run build", { cwd: repoDir, stdio: "inherit" });
    console.log("");
    console.log(chalk.green("  ✓ clink updated successfully!"));
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  ✗ Update failed: ${message}\n`));
    process.exit(1);
  }
}

// ── Send handler ──

async function resolveTargetChat(config: ClinkConfig, msg: Messages, explicitChatId: number | null): Promise<number | null> {
  if (explicitChatId) {
    return explicitChatId;
  }
  if (config.allowedUsers.length === 0) {
    p.log.error(msg.sendNoUsers);
    return null;
  }
  if (config.allowedUsers.length === 1) {
    return config.allowedUsers[0];
  }
  const chosen = await p.select({
    message: msg.sendChooseUser,
    options: config.allowedUsers.map((id) => ({ value: id, label: String(id) })),
  });
  if (p.isCancel(chosen)) return null;
  const val = chosen as number;
  return val;
}

async function handleSend(config: ClinkConfig, msg: Messages): Promise<void> {
  if (!config.token) {
    p.log.error(msg.tokenNotConfigured + " " + accent("clink onboard") + " " + msg.toConfigure);
    process.exit(1);
  }

  const args = process.argv.slice(3);

  // Parse --to (DM) or --to-group (group/channel) flag for custom chat ID
  let explicitChatId: number | null = null;
  const toIdx = args.indexOf("--to");
  const toGroupIdx = args.indexOf("--to-group");

  if (toGroupIdx !== -1) {
    const raw = args[toGroupIdx + 1];
    if (!raw || isNaN(Number(raw))) {
      p.log.error(msg.sendInvalidChatId);
      process.exit(1);
    }
    const numId = Number(raw);
    // Group IDs in Telegram are negative; auto-prefix if user passes positive
    explicitChatId = numId > 0 ? -numId : numId;
    args.splice(toGroupIdx, 2);
  } else if (toIdx !== -1) {
    const raw = args[toIdx + 1];
    if (!raw || isNaN(Number(raw))) {
      p.log.error(msg.sendInvalidChatId);
      process.exit(1);
    }
    explicitChatId = Number(raw);
    args.splice(toIdx, 2);
  }

  const chatId = await resolveTargetChat(config, msg, explicitChatId);
  if (!chatId) return;

  const bot = createBot(config.token);

  // Parse args: clink send -f /path "caption" OR clink send "text"
  const fileIdx = args.indexOf("-f");

  if (fileIdx !== -1) {
    // File mode
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      p.log.error(msg.sendFileNotFound("(empty)"));
      process.exit(1);
    }

    const resolvedPath = filePath.replace(/^~/, homedir());
    if (!existsSync(resolvedPath)) {
      p.log.error(msg.sendFileNotFound(resolvedPath));
      process.exit(1);
    }

    // Caption is everything else that's not -f or the file path
    const captionParts = args.filter((_, i) => i !== fileIdx && i !== fileIdx + 1);
    const caption = captionParts.join(" ").trim() || undefined;

    const s = p.spinner();
    s.start(msg.sendSending);
    try {
      await sendFile(bot, chatId, resolvedPath, caption);
      s.stop(chalk.green(msg.sendSuccess));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      s.stop(chalk.red(message));
      process.exit(1);
    }
  } else if (args.length > 0) {
    // Text mode (direct)
    const text = args.join(" ").trim();
    if (!text) return;

    const s = p.spinner();
    s.start(msg.sendSending);
    try {
      await sendText(bot, chatId, text);
      s.stop(chalk.green(msg.sendSuccess));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      s.stop(chalk.red(message));
      process.exit(1);
    }
  } else {
    // Interactive mode
    const action = await p.select({
      message: msg.sendChooseAction,
      options: [
        { value: "text", label: msg.sendTextOption },
        { value: "file", label: msg.sendFileOption },
      ],
    });

    if (p.isCancel(action)) return;

    const actionVal = action as string;

    if (actionVal === "text") {
      const text = await p.text({
        message: msg.sendText,
        placeholder: "...",
        validate: (v) => { if (!v || !v.trim()) return msg.sendText; },
      });
      if (p.isCancel(text)) return;

      const textVal = text as string;
      const s = p.spinner();
      s.start(msg.sendSending);
      try {
        await sendText(bot, chatId, textVal.trim());
        s.stop(chalk.green(msg.sendSuccess));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        s.stop(chalk.red(message));
      }
    } else {
      const filePath = await p.text({
        message: msg.sendFilePath,
        placeholder: msg.sendFilePathPlaceholder,
        validate: (v) => {
          if (!v || !v.trim()) return msg.sendFilePath;
          const resolved = v.trim().replace(/^~/, homedir());
          if (!existsSync(resolved)) return msg.sendFileNotFound(resolved);
        },
      });
      if (p.isCancel(filePath)) return;

      const fileVal = filePath as string;

      const caption = await p.text({
        message: msg.sendCaption,
        placeholder: msg.sendCaptionPlaceholder,
      });
      const captionText = p.isCancel(caption) ? undefined : ((caption as string).trim() || undefined);

      const resolvedPath = fileVal.trim().replace(/^~/, homedir());
      const s = p.spinner();
      s.start(msg.sendSending);
      try {
        await sendFile(bot, chatId, resolvedPath, captionText);
        s.stop(chalk.green(msg.sendSuccess));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        s.stop(chalk.red(message));
      }
    }
  }
}

// ── Entry ──

async function main(): Promise<void> {
  const arg = process.argv[2];
  const config = loadConfig();
  const msg = t(config.language);

  switch (arg) {
    case "help":
    case "--help":
    case "-h":
      showBanner();
      showHelp();
      return;

    case "onboard":
    case "setup": {
      console.clear();
      showBanner();
      console.log("");
      const wizResult = await runWizard();
      if (wizResult === "start") {
        launchGateway(loadConfig(), t(loadConfig().language));
        return;
      }
      mainMenu();
      return;
    }

    case "send":
      await handleSend(config, msg);
      return;

    case "update":
    case "upgrade":
      updateFromMain();
      return;

    case "gateway":
    case "start":
      if (!config.token) {
        p.intro(accent.bold(" clink "));
        p.log.error(msg.tokenNotConfigured + " " + accent("clink onboard") + " " + msg.toConfigure);
        p.outro("");
        process.exit(1);
      }
      launchGateway(config, msg);
      return;

    case "stop": {
      const gw = getGatewayStatus();
      if (gw.running) {
        process.kill(gw.pid!, "SIGTERM");
        clearPid();
        console.log(chalk.green(`  Gateway stopped (pid ${gw.pid})`));
      } else {
        console.log(dim("  Gateway is not running"));
      }
      return;
    }

    case "restart": {
      const gw = getGatewayStatus();
      if (gw.running) {
        process.kill(gw.pid!, "SIGTERM");
        clearPid();
        console.log(dim(`  Stopped previous gateway (pid ${gw.pid})`));
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!config.token) {
        p.log.error(msg.tokenNotConfigured + " " + accent("clink onboard") + " " + msg.toConfigure);
        process.exit(1);
      }
      launchGateway(config, msg);
      return;
    }

    case "status": {
      const gw = getGatewayStatus();
      showBanner();
      console.log("");
      if (gw.running) {
        console.log(`  ${chalk.green("●")} Gateway ${chalk.green(msg.running)}  ${dim(`pid ${gw.pid}`)}`);
        console.log(`  ${dim(msg.gatewayModel)}:        ${accent(config.model || "sonnet")}`);
        console.log(`  ${dim(msg.gatewayDirectory)}:    ${chalk.blue(config.workingDir)}`);
        console.log(`  ${dim(msg.gatewayPermissions)}:  ${config.skipPermissions ? msg.autonomous : msg.askApproval}`);
        console.log(`  ${dim(msg.gatewayAllowed)}:      ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : msg.allUsers}`);
        console.log(`  ${dim("Sessions")}:      ${accent(String(listClaudeSessions(config.workingDir).length))}`);
      } else {
        console.log(`  ${chalk.red("○")} Gateway ${chalk.red(msg.stopped)}`);
      }
      console.log("");
      return;
    }

    default: {
      // No arg — first run or menu
      if (!config.token) {
        console.clear();
        showBanner();
        console.log("");
        const result = await runWizard();
        if (result === "start") {
          launchGateway(loadConfig(), t(loadConfig().language));
          return;
        }
      }
      mainMenu();
    }
  }
}

main();
