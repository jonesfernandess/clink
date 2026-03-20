import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { CONFIG_DIR } from "./config.js";

const ACTIVE_SESSIONS_FILE = join(CONFIG_DIR, "active-sessions.json");

// ── Path encoding (matches Claude CLI convention) ──

function encodeProjectPath(dir) {
  return dir.replace(/\//g, "-");
}

function projectDir(workingDir) {
  return join(homedir(), ".claude", "projects", encodeProjectPath(workingDir));
}

// ── Parse a .jsonl session file for metadata ──

function parseSessionFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    const lines = content.split("\n");

    let sessionId = null;
    let firstPrompt = null;
    let firstTimestamp = null;
    let messageCount = 0;

    for (const line of lines) {
      const obj = JSON.parse(line);
      if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      if (obj.type === "user") {
        messageCount++;
        if (!firstPrompt) {
          const msg = obj.message?.content || obj.message;
          firstPrompt = typeof msg === "string" ? msg.slice(0, 120) : "";
          firstTimestamp = obj.timestamp;
        }
      }
    }

    if (!sessionId) return null;

    const stat = statSync(filePath);
    return {
      sessionId,
      firstPrompt: firstPrompt || "",
      summary: firstPrompt || "",
      messageCount,
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      fullPath: filePath,
    };
  } catch {
    return null;
  }
}

// ── Active session pointers (chatId → sessionId) ──

function loadActiveMap() {
  if (!existsSync(ACTIVE_SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ACTIVE_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveActiveMap(map) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ACTIVE_SESSIONS_FILE, JSON.stringify(map, null, 2));
}

// ── Public API ──

export function getActiveSession(chatId) {
  const map = loadActiveMap();
  return map[String(chatId)] || null;
}

export function setActiveSession(chatId, sessionId) {
  const map = loadActiveMap();
  map[String(chatId)] = sessionId;
  saveActiveMap(map);
}

export function clearActiveSession(chatId) {
  const map = loadActiveMap();
  delete map[String(chatId)];
  saveActiveMap(map);
}

export function listClaudeSessions(workingDir, limit = 15) {
  const dir = projectDir(workingDir);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    // Sort by mtime desc first (cheap), then only parse the top N
    const withMtime = files.map((f) => {
      const full = join(dir, f);
      return { file: full, mtime: statSync(full).mtimeMs };
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const sessions = [];
    for (const { file } of withMtime) {
      const entry = parseSessionFile(file);
      if (entry && entry.messageCount > 0) sessions.push(entry);
      if (sessions.length >= limit) break;
    }
    return sessions;
  } catch {
    return [];
  }
}

export function findSession(workingDir, sessionId) {
  const filePath = join(projectDir(workingDir), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;
  return parseSessionFile(filePath);
}
