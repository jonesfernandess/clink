import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CONFIG_DIR } from "./config.js";

const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

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

export function getSession(chatId) {
  const sessions = loadSessions();
  return sessions[String(chatId)] || null;
}

export function createSession(chatId) {
  const sessions = loadSessions();
  const session = {
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    messageCount: 0,
  };
  sessions[String(chatId)] = session;
  saveSessions(sessions);
  return session;
}

export function clearSession(chatId) {
  const sessions = loadSessions();
  delete sessions[String(chatId)];
  saveSessions(sessions);
}

export function touchSession(chatId) {
  const sessions = loadSessions();
  const session = sessions[String(chatId)];
  if (session) {
    session.lastUsedAt = new Date().toISOString();
    session.messageCount = (session.messageCount || 0) + 1;
    saveSessions(sessions);
  }
}

export function getSessionCount() {
  const sessions = loadSessions();
  return Object.keys(sessions).length;
}
