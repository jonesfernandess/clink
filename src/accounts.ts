import { spawn } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig, saveConfig } from "./config.js";
import type { AccountConfig, AccountsConfig, Provider } from "./types.js";

// ── State (in-memory, not persisted) ──

let currentClaudeIdx = 0;
let currentCodexIdx = 0;

// ── Base directories ──

const CODEX_ACCOUNTS_DIR = join(homedir(), ".codex-accounts");
const CLAUDE_ACCOUNTS_DIR = join(homedir(), ".claude-accounts");
const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const DEFAULT_CLAUDE_HOME = join(homedir(), ".claude");

// ── Quota error detection ──

const QUOTA_PATTERNS = [
  /rate.?limit/i,
  /quota.?exceed/i,
  /429/,
  /insufficient.?quota/i,
  /billing.?limit/i,
  /usage.?limit/i,
  /overloaded/i,
  /rate_limit_error/i,
  /too.?many.?requests/i,
  /resource.?exhausted/i,
];

export function isQuotaError(errMessage: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(errMessage));
}

// ── Account access ──

function getAccounts(provider: Provider): AccountConfig[] {
  const config = loadConfig();
  if (!config.accounts) return [];
  return (provider === "claude" ? config.accounts.claude : config.accounts.codex) || [];
}

export function getAccountCount(provider: Provider): number {
  return getAccounts(provider).length;
}

export function getCurrentAccount(provider: Provider): AccountConfig | null {
  const accounts = getAccounts(provider);
  if (accounts.length === 0) return null;
  const idx = resolveCurrentIdx(provider, accounts);
  return accounts[idx] || null;
}

/** Resolve the current index: prefer persisted activeAccounts, fallback to in-memory idx */
function resolveCurrentIdx(provider: Provider, accounts: AccountConfig[]): number {
  const config = loadConfig();
  const activeId = config.activeAccounts?.[provider];
  if (activeId) {
    const idx = accounts.findIndex((a) => a.id === activeId);
    if (idx !== -1) {
      // Sync in-memory state
      if (provider === "claude") currentClaudeIdx = idx;
      else currentCodexIdx = idx;
      return idx;
    }
  }
  const memIdx = provider === "claude" ? currentClaudeIdx : currentCodexIdx;
  return memIdx % accounts.length;
}

export function setCurrentAccount(provider: Provider, id: string): boolean {
  const accounts = getAccounts(provider);
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  if (provider === "claude") currentClaudeIdx = idx;
  else currentCodexIdx = idx;
  // Persist to config
  const config = loadConfig();
  if (!config.activeAccounts) config.activeAccounts = {};
  config.activeAccounts[provider] = id;
  saveConfig(config);

  return true;
}

export function listAccounts(provider?: Provider): AccountConfig[] {
  if (provider) return getAccounts(provider);
  const config = loadConfig();
  if (!config.accounts) return [];
  return [...(config.accounts.claude || []), ...(config.accounts.codex || [])];
}

// ── Environment injection ──

export function getAccountEnv(provider: Provider): NodeJS.ProcessEnv {
  const account = getCurrentAccount(provider);
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (!account) return env;

  if (provider === "codex") {
    if (account.configDir) {
      env.CODEX_HOME = expandTilde(account.configDir);
    }
    if (account.apiKey) {
      env.OPENAI_API_KEY = account.apiKey;
    }
  } else {
    if (account.configDir) {
      const resolved = expandTilde(account.configDir);
      // Only set CLAUDE_CONFIG_DIR for non-default directories;
      // setting it to ~/.claude breaks auth in Claude CLI
      if (resolved !== DEFAULT_CLAUDE_HOME) {
        env.CLAUDE_CONFIG_DIR = resolved;
      }
    }
    if (account.apiKey) {
      env.ANTHROPIC_API_KEY = account.apiKey;
    }
  }

  return env;
}

// ── Rotation ──

/** Advance to the next account (round-robin). Returns the new account or null if only one exists. */
export function rotateAccount(provider: Provider): AccountConfig | null {
  const accounts = getAccounts(provider);
  if (accounts.length <= 1) return null;

  const currentIdx = provider === "claude" ? currentClaudeIdx : currentCodexIdx;
  const nextIdx = (currentIdx + 1) % accounts.length;

  if (provider === "claude") currentClaudeIdx = nextIdx;
  else currentCodexIdx = nextIdx;

  return accounts[nextIdx];
}

// ── Provisioning ──

export function provisionCodexAccount(id: string): string {
  const targetDir = join(CODEX_ACCOUNTS_DIR, id);
  mkdirSync(targetDir, { recursive: true });

  // Copy config.toml if exists
  const srcConfig = join(DEFAULT_CODEX_HOME, "config.toml");
  if (existsSync(srcConfig)) {
    copyFileSync(srcConfig, join(targetDir, "config.toml"));
  }

  // Create empty auth.json to force fresh login
  writeFileSync(join(targetDir, "auth.json"), "{}");

  // Create structural dirs
  for (const dir of ["cache", "sessions", "memories", "rules", "skills", "tmp"]) {
    mkdirSync(join(targetDir, dir), { recursive: true });
  }

  return targetDir;
}

export function provisionClaudeAccount(id: string): string {
  const targetDir = join(CLAUDE_ACCOUNTS_DIR, id);
  mkdirSync(targetDir, { recursive: true });

  // Copy settings files if they exist
  for (const file of ["settings.json", "settings.local.json"]) {
    const src = join(DEFAULT_CLAUDE_HOME, file);
    if (existsSync(src)) {
      copyFileSync(src, join(targetDir, file));
    }
  }

  return targetDir;
}

export function runInteractiveLogin(provider: Provider, configDir: string, deviceAuth = false): Promise<boolean> {
  return new Promise((resolve) => {
    const envVar = provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const cmd = provider === "codex" ? "codex" : "claude";
    const args = deviceAuth ? ["login", "--device-auth"] : ["login"];

    const proc = spawn(cmd, args, {
      env: { ...process.env, [envVar]: configDir },
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }

      // Verify auth was successful
      if (provider === "codex") {
        const authFile = join(configDir, "auth.json");
        if (existsSync(authFile)) {
          try {
            const auth = JSON.parse(readFileSync(authFile, "utf-8"));
            resolve(auth.tokens || auth.OPENAI_API_KEY ? true : false);
          } catch {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      } else {
        // Claude login success is indicated by exit code 0
        resolve(true);
      }
    });

    proc.on("error", () => resolve(false));
  });
}

// ── Account CRUD ──

export function addAccount(provider: Provider, account: AccountConfig): void {
  const config = loadConfig();
  if (!config.accounts) config.accounts = {};

  const list = provider === "claude"
    ? (config.accounts.claude ||= [])
    : (config.accounts.codex ||= []);

  list.push(account);
  saveConfig(config);
}

export function removeAccount(provider: Provider, id: string): boolean {
  const config = loadConfig();
  if (!config.accounts) return false;

  const key = provider === "claude" ? "claude" : "codex";
  const list = config.accounts[key];
  if (!list) return false;

  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return false;

  list.splice(idx, 1);
  saveConfig(config);
  return true;
}

export function ensureDefaultAccount(provider: Provider): void {
  const accounts = getAccounts(provider);
  const defaultId = `${provider}-default`;

  if (accounts.some((a) => a.id === defaultId)) return;

  const defaultDir = provider === "codex" ? DEFAULT_CODEX_HOME : DEFAULT_CLAUDE_HOME;
  if (!existsSync(defaultDir)) return;

  const config = loadConfig();
  if (!config.accounts) config.accounts = {};

  const list = provider === "claude"
    ? (config.accounts.claude ||= [])
    : (config.accounts.codex ||= []);

  list.unshift({
    id: defaultId,
    label: "Default",
    configDir: defaultDir,
  });

  saveConfig(config);
}

export function generateAccountId(provider: Provider): string {
  const accounts = getAccounts(provider);
  let n = accounts.length + 1;
  while (accounts.some((a) => a.id === `${provider}-${n}`)) {
    n++;
  }
  return `${provider}-${n}`;
}

// ── Email extraction ──

/** Extract email from a Codex account's auth.json JWT id_token */
export function getAccountEmail(account: AccountConfig): string | null {
  const configDir = account.configDir;
  if (!configDir) return null;

  const authFile = join(configDir, "auth.json");
  if (!existsSync(authFile)) return null;

  try {
    const auth = JSON.parse(readFileSync(authFile, "utf-8"));
    const idToken = auth.tokens?.id_token;
    if (!idToken) return null;

    // Decode JWT payload (base64url)
    const parts = idToken.split(".");
    if (parts.length < 2) return null;

    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";

    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch {
    return null;
  }
}

// ── Utils ──

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}
