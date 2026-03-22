import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { CONFIG_DIR } from "./config.js";
import type { SessionEntry, ActiveSessionMap } from "./types.js";

const ACTIVE_SESSIONS_FILE = join(CONFIG_DIR, "active-sessions.json");
const PENDING_SESSIONS_FILE = join(CONFIG_DIR, "pending-sessions.json");

interface PendingSession {
  sessionId: string;
  prompt: string;
  created: string;
}

// ── Path encoding (matches Claude CLI convention) ──

function encodeProjectPath(dir: string): string {
  return dir.replace(/\//g, "-");
}

function projectDir(workingDir: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectPath(workingDir),
  );
}

// ── Ghost session detection (created by classifier/resolver auxiliary spawns) ──

const GHOST_PATTERNS = [
  /^classify this/i,
  /^do not execute anything/i,
  /^reply with a single word/i,
  /^the user wants to perform a destructive/i,
];

function isGhostSession(firstPrompt: string): boolean {
  return GHOST_PATTERNS.some((p) => p.test(firstPrompt));
}

/** Detect system-injected user messages that lack isMeta flag */
const SYSTEM_MSG_PATTERNS = [
  /^<command-name>/,
  /^<local-command-stdout>/,
  /^<local-command-caveat>/,
  /^<system-reminder>/,
  /^<command-message>/,
];

function isSystemMessage(obj: { isMeta?: boolean; message?: { content?: string } }): boolean {
  if (obj.isMeta) return true;
  const content = typeof obj.message?.content === "string" ? obj.message.content : "";
  return SYSTEM_MSG_PATTERNS.some((p) => p.test(content));
}

/** Strip system-injected XML tags and residual system text from session preview */
function sanitizePreview(text: string): string {
  // Strip all XML-style tags (including content between known system tags)
  let clean = text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/<[^>]+>/g, "")  // catch remaining unpaired tags
    .trim();
  // Strip residual system preamble that leaks after tag removal
  clean = clean.replace(/^Caveat:.*?(\.|\n)/s, "").trim();
  clean = clean.replace(/^DO NOT respond[^.]*\./s, "").trim();
  clean = clean.replace(/^comando\s+\S+\s*/i, "").trim();
  return clean;
}

// ── Parse a .jsonl session file for metadata ──

function parseSessionFile(filePath: string): SessionEntry | null {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    const lines = content.split("\n");

    let sessionId: string | null = null;
    let firstPrompt: string | null = null;
    let firstTimestamp: string | null = null;
    let messageCount = 0;

    for (const line of lines) {
      const obj = JSON.parse(line);
      if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      if (obj.type === "user" && !isSystemMessage(obj)) {
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
    const cleanPrompt = sanitizePreview(firstPrompt || "");
    return {
      sessionId,
      firstPrompt: cleanPrompt,
      summary: cleanPrompt,
      messageCount,
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      fullPath: filePath,
    };
  } catch {
    return null;
  }
}

// ── Active session pointers (chatId -> sessionId) ──

function loadActiveMap(): ActiveSessionMap {
  if (!existsSync(ACTIVE_SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ACTIVE_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveActiveMap(map: ActiveSessionMap): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ACTIVE_SESSIONS_FILE, JSON.stringify(map, null, 2));
}

// ── Pending sessions (visible before .jsonl exists on disk) ──

function loadPendingMap(): Record<string, PendingSession> {
  if (!existsSync(PENDING_SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PENDING_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function savePendingMap(map: Record<string, PendingSession>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PENDING_SESSIONS_FILE, JSON.stringify(map, null, 2));
}

// ── Public API ──

export function getActiveSession(chatId: number): string | null {
  const map = loadActiveMap();
  return map[String(chatId)] || null;
}

export function setActiveSession(chatId: number, sessionId: string): void {
  const map = loadActiveMap();
  map[String(chatId)] = sessionId;
  saveActiveMap(map);
}

export function clearActiveSession(chatId: number): void {
  const map = loadActiveMap();
  delete map[String(chatId)];
  saveActiveMap(map);
}

export function registerPendingSession(sessionId: string, prompt: string): void {
  const map = loadPendingMap();
  map[sessionId] = { sessionId, prompt: prompt.slice(0, 120), created: new Date().toISOString() };
  savePendingMap(map);
}

export function removePendingSession(sessionId: string): void {
  const map = loadPendingMap();
  if (map[sessionId]) {
    delete map[sessionId];
    savePendingMap(map);
  }
}

export function listClaudeSessions(
  workingDir: string,
  limit: number = 15,
): SessionEntry[] {
  const dir = projectDir(workingDir);
  const diskIds = new Set<string>();
  const sessions: SessionEntry[] = [];

  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      const withMtime = files.map((f) => {
        const full = join(dir, f);
        return { file: full, mtime: statSync(full).mtimeMs };
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      for (const { file } of withMtime) {
        const entry = parseSessionFile(file);
        if (entry && entry.messageCount > 0 && !isGhostSession(entry.firstPrompt)) {
          sessions.push(entry);
          diskIds.add(entry.sessionId);
        }
        if (sessions.length >= limit) break;
      }
    } catch { /* ignore */ }
  }

  // Merge pending sessions whose .jsonl doesn't exist yet
  const pending = loadPendingMap();
  let pendingChanged = false;
  for (const [id, p] of Object.entries(pending)) {
    if (diskIds.has(id)) {
      // .jsonl now exists — pending entry no longer needed
      delete pending[id];
      pendingChanged = true;
      continue;
    }
    if (sessions.length < limit) {
      sessions.push({
        sessionId: p.sessionId,
        firstPrompt: sanitizePreview(p.prompt),
        summary: sanitizePreview(p.prompt),
        messageCount: 1,
        created: p.created,
        modified: p.created,
        fullPath: "",
      });
    }
  }
  if (pendingChanged) savePendingMap(pending);

  // Re-sort so pending sessions appear in correct chronological position
  sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return sessions.slice(0, limit);
}

export function findSession(
  workingDir: string,
  sessionId: string,
): SessionEntry | null {
  const filePath = join(projectDir(workingDir), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;
  return parseSessionFile(filePath);
}
