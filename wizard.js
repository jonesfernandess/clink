import * as p from "@clack/prompts";
import chalk from "chalk";
import { execSync } from "child_process";
import { loadConfig, saveConfig } from "./config.js";
import { t, LANGUAGE_NAMES } from "./i18n.js";

const accent = chalk.hex("#FF5A2D");
const dim = chalk.dim;

function checkClaude() {
  try {
    const version = execSync("claude --version 2>/dev/null", { encoding: "utf-8" }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

function checkClaudeAuth() {
  try {
    const result = execSync('claude --print "ping" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 15000,
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

export async function runWizard() {
  const config = loadConfig();

  // Step 0: Language (always ask first, in English)
  const lang = await p.select({
    message: "Choose your language / Escolha seu idioma / Elige tu idioma",
    options: Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label })),
    initialValue: config.language || "en",
  });

  if (p.isCancel(lang)) {
    p.outro(dim("Bye!"));
    process.exit(0);
  }

  config.language = lang;
  saveConfig(config);
  const msg = t(lang);

  p.log.step(accent(msg.wizardWelcome));
  console.log("");

  // Step 1: Check Claude CLI
  p.log.info(dim(msg.wizardChecking));

  const claude = checkClaude();
  if (!claude.installed) {
    p.log.error(msg.wizardClaudeNotFound);
    p.log.message(chalk.yellow(msg.wizardClaudeInstall));
    p.outro("");
    process.exit(1);
  }

  p.log.success(`${msg.wizardClaudeFound} ${dim(msg.wizardClaudeVersion(claude.version))}`);

  const s = p.spinner();
  s.start(dim("Checking authentication..."));
  const authed = checkClaudeAuth();
  s.stop(authed ? msg.wizardClaudeAuth : msg.wizardClaudeNotAuth);

  if (!authed) {
    p.log.error(chalk.yellow(msg.wizardClaudeNotAuth));
    p.outro("");
    process.exit(1);
  }

  console.log("");

  // Step 2: Telegram token
  p.log.step(accent(msg.wizardStep(1, 3)) + dim(" — Telegram Bot Token"));
  console.log("");
  p.log.message(dim(msg.wizardTokenStep1));
  p.log.message(dim(msg.wizardTokenStep2));
  p.log.message(dim(msg.wizardTokenStep3));
  console.log("");

  const token = await p.text({
    message: msg.tokenPrompt,
    placeholder: msg.tokenPlaceholder,
    validate: (v) => {
      if (!v.trim()) return msg.tokenRequired;
      if (!v.includes(":")) return msg.tokenInvalid;
    },
  });

  if (p.isCancel(token)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  config.token = token.trim();
  saveConfig(config);
  p.log.success(msg.tokenSaved);
  console.log("");

  // Step 3: User ID
  p.log.step(accent(msg.wizardStep(2, 3)) + dim(" — Allowed Users"));
  console.log("");
  p.log.message(dim(msg.wizardUserIntro));
  p.log.message(dim(msg.wizardUserHow));
  console.log("");

  const userAction = await p.select({
    message: msg.manageUsers,
    options: [
      { value: "add", label: msg.addUser },
      { value: "skip", label: msg.wizardUserSkip },
    ],
  });

  if (p.isCancel(userAction)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  if (userAction === "add") {
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
      }
    }
  } else {
    p.log.warn(dim(msg.noUsersConfigured));
  }

  console.log("");

  // Step 4: Model
  p.log.step(accent(msg.wizardStep(3, 3)) + dim(" — Claude Model"));
  console.log("");
  p.log.message(dim(msg.wizardModelIntro));
  console.log("");

  const model = await p.select({
    message: msg.modelPrompt,
    options: [
      { value: "sonnet", label: "Sonnet", hint: msg.sonnetHint },
      { value: "opus", label: "Opus", hint: msg.opusHint },
      { value: "haiku", label: "Haiku", hint: msg.haikuHint },
    ],
    initialValue: config.model || "sonnet",
  });

  if (p.isCancel(model)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  config.model = model;
  saveConfig(config);
  p.log.success(msg.modelChanged(accent(model)));

  console.log("");
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  p.log.success(chalk.bold(msg.wizardReady));
  p.log.message(dim(msg.wizardDone));
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  console.log("");

  // Ask to start now
  const startNow = await p.confirm({
    message: msg.wizardStartNow || `${msg.menuStart}?`,
  });

  if (!p.isCancel(startNow) && startNow) {
    return "start";
  }

  return "menu";
}
