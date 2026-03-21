import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".config", "clink");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  token: "",
  allowedUsers: [],
  model: "sonnet",
  systemPrompt: "",
  workingDir: homedir(),
  skipPermissions: true,
  language: "en",
};

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export { CONFIG_DIR, CONFIG_FILE };
