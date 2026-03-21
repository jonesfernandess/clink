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

const accent = chalk.hex("#FF5A2D");
const dim = chalk.dim;
const ccGradient = gradient(["#FF5A2D", "#FF8C42", "#FFD700"]);

const PID_FILE = join(homedir(), ".config", "clink", "gateway.pid");

// ── PID helpers ──

function savePid(pid) {
  writeFileSync(PID_FILE, String(pid));
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

function clearPid() {
  try { unlinkSync(PID_FILE); } catch {}
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getGatewayStatus() {
  const pid = readPid();
  if (pid && isRunning(pid)) return { running: true, pid };
  if (pid) clearPid(); // stale pid
  return { running: false, pid: null };
}

// ── Banner ──

function showBanner() {
  const banner = figlet.textSync("CLINK", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted",
  });
  console.log("");
  console.log(ccGradient(banner));
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  console.log(`  ${accent("●")} ${chalk.bold.white("CLINK")}  ${dim("— Claude Code via Telegram")}`);
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
}

function maskToken(token, msg) {
  if (!token) return chalk.red(msg.notConfigured);
  return chalk.green(token.slice(0, 6) + "..." + token.slice(-4));
}

function statusBar(config, msg) {
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

async function mainMenu() {
  const config = loadConfig();
  const msg = t(config.language);

  console.clear();
  showBanner();
  statusBar(config, msg);

  const gw = getGatewayStatus();

  const options = [];
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

  switch (action) {
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

function launchGateway(config, msg) {
  p.outro(accent.bold(msg.startingGateway));
  console.log("");
  const bot = startBot(config);
  savePid(process.pid);

  process.on("SIGINT", () => {
    clearPid();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearPid();
    process.exit(0);
  });

  return bot;
}

async function handleStart(config, msg) {
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

async function handleStop(msg) {
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

async function handleRestart(config, msg) {
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

async function handleStatus(config, msg) {
  const gw = getGatewayStatus();
  console.log("");
  if (gw.running) {
    p.log.success(`Gateway ${chalk.green(msg.running)} — pid ${gw.pid}`);
    p.log.info(`${msg.gatewayModel}: ${accent(config.model || "sonnet")}`);
    p.log.info(`${msg.gatewayDirectory}: ${chalk.blue(config.workingDir)}`);
    p.log.info(`${msg.gatewayPermissions}: ${config.skipPermissions ? msg.autonomous : msg.askApproval}`);
    p.log.info(`${msg.gatewayAllowed}: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : msg.allUsers}`);
    p.log.info(`Sessions: ${accent(listClaudeSessions(config.workingDir).length)}`);
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

async function handleToken(config, msg) {
  const token = await p.text({
    message: msg.tokenPrompt,
    placeholder: msg.tokenPlaceholder,
    initialValue: config.token || "",
    validate: (v) => {
      if (!v.trim()) return msg.tokenRequired;
      if (!v.includes(":")) return msg.tokenInvalid;
    },
  });

  if (p.isCancel(token)) return mainMenu();

  config.token = token.trim();
  saveConfig(config);
  p.log.success(msg.tokenSaved);
  return mainMenu();
}

async function handleModel(config, msg) {
  const model = await p.select({
    message: msg.modelPrompt,
    options: [
      { value: "sonnet", label: "Sonnet", hint: msg.sonnetHint },
      { value: "opus", label: "Opus", hint: msg.opusHint },
      { value: "haiku", label: "Haiku", hint: msg.haikuHint },
    ],
    initialValue: config.model || "sonnet",
  });

  if (p.isCancel(model)) return mainMenu();

  config.model = model;
  saveConfig(config);
  p.log.success(msg.modelChanged(accent(model)));
  return mainMenu();
}

async function handleWorkdir(config, msg) {
  const workdir = await p.text({
    message: msg.workdirPrompt,
    placeholder: homedir(),
    initialValue: config.workingDir || homedir(),
  });

  if (p.isCancel(workdir)) return mainMenu();

  const dir = workdir.replace(/^~/, homedir()).trim();
  if (!existsSync(dir)) {
    p.log.error(msg.workdirNotFound(dir));
  } else {
    config.workingDir = dir;
    saveConfig(config);
    p.log.success(msg.workdirChanged(chalk.blue(dir)));
  }
  return mainMenu();
}

async function handleUsers(config, msg) {
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

  if (p.isCancel(action) || action === "back") return mainMenu();

  if (action === "add") {
    const userId = await p.text({
      message: msg.userIdPrompt,
      placeholder: msg.userIdPlaceholder,
      validate: (v) => {
        if (!v.trim() || isNaN(Number(v.trim()))) return msg.userIdInvalid;
      },
    });
    if (!p.isCancel(userId)) {
      const id = Number(userId.trim());
      if (!config.allowedUsers.includes(id)) {
        config.allowedUsers.push(id);
        saveConfig(config);
        p.log.success(msg.userAdded(accent(id)));
      } else {
        p.log.warn(msg.userAlreadyExists);
      }
    }
  } else if (action === "remove" && config.allowedUsers.length > 0) {
    const userId = await p.select({
      message: msg.removeWhich,
      options: config.allowedUsers.map((u) => ({ value: u, label: String(u) })),
    });
    if (!p.isCancel(userId)) {
      config.allowedUsers = config.allowedUsers.filter((u) => u !== userId);
      saveConfig(config);
      p.log.success(msg.userRemoved(userId));
    }
  } else if (action === "clear") {
    const confirm = await p.confirm({ message: msg.clearConfirm });
    if (!p.isCancel(confirm) && confirm) {
      config.allowedUsers = [];
      saveConfig(config);
      p.log.success(msg.listCleared);
    }
  }

  return mainMenu();
}

async function handlePermissions(config, msg) {
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

  config.skipPermissions = skip;
  saveConfig(config);

  if (skip) {
    p.log.success(msg.permAutoEnabled);
    p.log.warn(dim(msg.permAutoNote));
  } else {
    p.log.success(msg.permSafeEnabled);
    p.log.warn(dim(msg.permSafeNote));
  }

  return mainMenu();
}

async function handlePrompt(config, msg) {
  const prompt = await p.text({
    message: msg.promptMessage,
    placeholder: msg.promptPlaceholder,
    initialValue: config.systemPrompt || "",
  });

  if (p.isCancel(prompt)) return mainMenu();

  config.systemPrompt = prompt.trim();
  saveConfig(config);
  p.log.success(config.systemPrompt ? msg.promptSaved : msg.promptRemoved);
  return mainMenu();
}

async function handleLanguage(config, msg) {
  const lang = await p.select({
    message: msg.languagePrompt,
    options: Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label })),
    initialValue: config.language || "en",
  });

  if (p.isCancel(lang)) return mainMenu();

  config.language = lang;
  saveConfig(config);

  const newMsg = t(lang);
  p.log.success(newMsg.languageChanged(LANGUAGE_NAMES[lang]));
  return mainMenu();
}

// ── Help ──

function showHelp() {
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
  console.log("  Run without arguments to open the interactive menu.");
  console.log("");
}

// ── Auto-update ──

function getRepoDir() {
  return new URL(".", import.meta.url).pathname.replace(/\/$/, "");
}

function updateFromMain() {
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
    console.log(chalk.green("  ✓ clink updated successfully!"));
    console.log("");
  } catch (err) {
    console.error(chalk.red(`\n  ✗ Update failed: ${err.message}\n`));
    process.exit(1);
  }
}

// ── Send handler ──

async function resolveTargetChat(config, msg, explicitChatId) {
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
  return chosen;
}

async function handleSend(config, msg) {
  if (!config.token) {
    p.log.error(msg.tokenNotConfigured + " " + accent("clink onboard") + " " + msg.toConfigure);
    process.exit(1);
  }

  const args = process.argv.slice(3);

  // Parse --to (DM) or --to-group (group/channel) flag for custom chat ID
  let explicitChatId = null;
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
    } catch (err) {
      s.stop(chalk.red(err.message));
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
    } catch (err) {
      s.stop(chalk.red(err.message));
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

    if (action === "text") {
      const text = await p.text({
        message: msg.sendText,
        placeholder: "...",
        validate: (v) => { if (!v.trim()) return msg.sendText; },
      });
      if (p.isCancel(text)) return;

      const s = p.spinner();
      s.start(msg.sendSending);
      try {
        await sendText(bot, chatId, text.trim());
        s.stop(chalk.green(msg.sendSuccess));
      } catch (err) {
        s.stop(chalk.red(err.message));
      }
    } else {
      const filePath = await p.text({
        message: msg.sendFilePath,
        placeholder: msg.sendFilePathPlaceholder,
        validate: (v) => {
          if (!v.trim()) return msg.sendFilePath;
          const resolved = v.trim().replace(/^~/, homedir());
          if (!existsSync(resolved)) return msg.sendFileNotFound(resolved);
        },
      });
      if (p.isCancel(filePath)) return;

      const caption = await p.text({
        message: msg.sendCaption,
        placeholder: msg.sendCaptionPlaceholder,
      });
      const captionText = p.isCancel(caption) ? undefined : (caption.trim() || undefined);

      const resolvedPath = filePath.trim().replace(/^~/, homedir());
      const s = p.spinner();
      s.start(msg.sendSending);
      try {
        await sendFile(bot, chatId, resolvedPath, captionText);
        s.stop(chalk.green(msg.sendSuccess));
      } catch (err) {
        s.stop(chalk.red(err.message));
      }
    }
  }
}

// ── Entry ──

async function main() {
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
    case "setup":
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
        process.kill(gw.pid, "SIGTERM");
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
        process.kill(gw.pid, "SIGTERM");
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
        console.log(`  ${dim("Sessions")}:      ${accent(listClaudeSessions(config.workingDir).length)}`);
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
