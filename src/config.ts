import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ClinkConfig } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "clink");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS: ClinkConfig = {
  token: "",
  allowedUsers: [],
  model: "sonnet",
  systemPrompt: "",
  workingDir: homedir(),
  skipPermissions: true,
  language: "en",
};

export function loadConfig(): ClinkConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: ClinkConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export { CONFIG_DIR, CONFIG_FILE };
