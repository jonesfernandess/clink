import * as p from "@clack/prompts";
import chalk from "chalk";
import { execSync } from "child_process";
import { loadConfig, saveConfig } from "./config.js";
import { t, LANGUAGE_NAMES } from "./i18n.js";
import type { ClinkConfig, Messages, SupportedLanguage } from "./types.js";

const accent = chalk.hex("#FF5A2D");
const dim = chalk.dim;

function checkClaude(): { installed: boolean; version: string | null } {
  try {
    const version = execSync("claude --version 2>/dev/null", { encoding: "utf-8" }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

function checkClaudeAuth(): boolean {
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

export async function runWizard(): Promise<"start" | "menu"> {
  const config: ClinkConfig = loadConfig();

  const lang = await p.select({
    message: "Choose your language / Escolha seu idioma / Elige tu idioma",
    options: Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label })),
    initialValue: config.language || "en",
  });

  if (p.isCancel(lang)) {
    p.outro(dim("Bye!"));
    process.exit(0);
  }

  config.language = lang as SupportedLanguage;
  saveConfig(config);
  const msg: Messages = t(lang as string);

  p.log.step(accent(msg.wizardWelcome));
  console.log("");

  // Security disclaimer
  p.log.warn(chalk.bold(msg.disclaimerTitle));
  console.log("");
  console.log(`  ${msg.disclaimerLine1}`);
  console.log(`  ${msg.disclaimerLine2}`);
  console.log(`  ${msg.disclaimerLine3}`);
  console.log("");
  console.log(dim(`  ${msg.disclaimerAsIs}`));
  console.log(dim(`  ${msg.disclaimerLiability}`));
  console.log(dim(`  ${msg.disclaimerResponsibility}`));
  console.log("");
  console.log(dim(`  ${msg.disclaimerRec}`));
  console.log(dim(`  ${msg.disclaimerRec1}`));
  console.log(dim(`  ${msg.disclaimerRec2}`));
  console.log(dim(`  ${msg.disclaimerRec3}`));
  console.log("");

  const accepted = await p.confirm({
    message: msg.disclaimerConfirm,
    initialValue: false,
  });

  if (p.isCancel(accepted) || !accepted) {
    p.outro(dim(msg.disclaimerCancelled));
    process.exit(0);
  }

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

  p.log.success(`${msg.wizardClaudeFound} ${dim(msg.wizardClaudeVersion(claude.version!))}`);

  const s = p.spinner();
  s.start(dim("Checking authentication..."));
  const authed: boolean = checkClaudeAuth();
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
      if (!v || !v.trim()) return msg.tokenRequired;
      if (!v.includes(":")) return msg.tokenInvalid;
    },
  });

  if (p.isCancel(token)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  config.token = (token as string).trim();
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
      { value: "add" as const, label: msg.addUser },
      { value: "skip" as const, label: msg.wizardUserSkip },
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
        if (!v || !v.trim() || isNaN(Number(v.trim()))) return msg.userIdInvalid;
      },
    });

    if (!p.isCancel(userId)) {
      const id: number = Number((userId as string).trim());
      if (!config.allowedUsers.includes(id)) {
        config.allowedUsers.push(id);
        saveConfig(config);
        p.log.success(msg.userAdded(accent(String(id))));
      }
    }
  } else {
    p.log.warn(dim(msg.noUsersConfigured));
  }

  console.log("");

  // Step 4: Model
  p.log.step(accent(msg.wizardStep(3, 3)) + dim(" — AI Model"));
  console.log("");
  p.log.message(dim(msg.wizardModelIntro));
  console.log("");

  let hasCodex = false;
  try {
    execSync("which codex", { encoding: "utf-8", stdio: "pipe" });
    hasCodex = true;
  } catch {}

  const modelOptions: Array<{ value: string; label: string; hint?: string }> = [
    { value: "sonnet", label: "Sonnet", hint: `Claude Code CLI — ${msg.sonnetHint}` },
    { value: "opus", label: "Opus", hint: `Claude Code CLI — ${msg.opusHint}` },
    { value: "haiku", label: "Haiku", hint: `Claude Code CLI — ${msg.haikuHint}` },
    { value: "gpt-5.4", label: "GPT-5.4", hint: hasCodex ? `Codex CLI — ${msg.codexLatestHint}` : msg.codexNotFound },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: hasCodex ? `Codex CLI — ${msg.codexMiniHint}` : msg.codexNotFound },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", hint: hasCodex ? `Codex CLI — ${msg.codexCodingHint}` : msg.codexNotFound },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", hint: hasCodex ? `Codex CLI — ${msg.codexFrontierHint}` : msg.codexNotFound },
    { value: "gpt-5.2", label: "GPT-5.2", hint: hasCodex ? `Codex CLI — ${msg.codexProHint}` : msg.codexNotFound },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", hint: hasCodex ? `Codex CLI — ${msg.codexMaxHint}` : msg.codexNotFound },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", hint: hasCodex ? `Codex CLI — ${msg.codexLiteHint}` : msg.codexNotFound },
  ];

  const model = await p.select({
    message: msg.modelPrompt,
    options: modelOptions,
    initialValue: config.model || "sonnet",
  });

  if (p.isCancel(model)) {
    p.outro(dim(msg.goodbye));
    process.exit(0);
  }

  const modelVal = model as string;

  // Block selection if codex not installed
  if (modelVal.startsWith("gpt-") && !hasCodex) {
    p.log.error(msg.codexNotFound + " — install: npm i -g @openai/codex");
    p.outro("");
    process.exit(1);
  }

  config.model = modelVal as ClinkConfig["model"];
  saveConfig(config);
  p.log.success(msg.modelChanged(accent(modelVal)));

  console.log("");
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  p.log.success(chalk.bold(msg.wizardReady));
  p.log.message(dim(msg.wizardDone));
  console.log(dim("  ─────────────────────────────────────────────────────────────"));
  console.log("");

  const startNow = await p.confirm({
    message: msg.wizardStartNow || `${msg.menuStart}?`,
  });

  if (!p.isCancel(startNow) && startNow) {
    return "start";
  }

  return "menu";
}
