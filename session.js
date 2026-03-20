import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CONFIG_DIR } from "./config.js";

const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

// Schema:
// {
//   "<chatId>": {
//     "active": "uuid" | null,
//     "history": [
//       {
//         "sessionId": "uuid",
//         "summary": "first message snippet",
//         "createdAt": "ISO",
//         "lastUsedAt": "ISO",
//         "messageCount": 0
//       }
//     ]
//   }
// }

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSessions(map) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2));
}

function ensureChat(sessions, chatId) {
  const key = String(chatId);
  if (!sessions[key]) {
    sessions[key] = { active: null, history: [] };
  }
  // Migrate old format (flat session object)
  if (sessions[key].sessionId && !sessions[key].history) {
    const old = sessions[key];
    sessions[key] = {
      active: old.sessionId,
      history: [{ ...old }],
    };
  }
  return sessions[key];
}

function findInHistory(chat, sessionId) {
  return chat.history.find((s) => s.sessionId === sessionId) || null;
}

export function getSession(chatId) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  if (!chat.active) return null;
  return findInHistory(chat, chat.active);
}

export function createSession(chatId, summary) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  const entry = {
    sessionId: randomUUID(),
    summary: summary ? summary.slice(0, 100) : "",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    messageCount: 0,
  };
  chat.history.push(entry);
  chat.active = entry.sessionId;
  // Keep last 20 sessions
  if (chat.history.length > 20) {
    chat.history = chat.history.slice(-20);
  }
  saveSessions(sessions);
  return entry;
}

export function clearSession(chatId) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  chat.active = null;
  saveSessions(sessions);
}

export function resumeSession(chatId, sessionId) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  const entry = findInHistory(chat, sessionId);
  if (!entry) return null;
  chat.active = sessionId;
  saveSessions(sessions);
  return entry;
}

export function touchSession(chatId, summary) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  if (!chat.active) return;
  const entry = findInHistory(chat, chat.active);
  if (entry) {
    entry.lastUsedAt = new Date().toISOString();
    entry.messageCount = (entry.messageCount || 0) + 1;
    if (summary && !entry.summary) {
      entry.summary = summary.slice(0, 100);
    }
    saveSessions(sessions);
  }
}

export function listSessions(chatId) {
  const sessions = loadSessions();
  const chat = ensureChat(sessions, chatId);
  return {
    active: chat.active,
    sessions: [...chat.history].reverse(),
  };
}

export function getSessionCount() {
  const sessions = loadSessions();
  return Object.values(sessions).filter((c) => c.active).length;
}
