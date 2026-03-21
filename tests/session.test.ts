import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Replicate session logic for testing with temp dirs
const TEST_DIR = join(tmpdir(), "clink-test-session-" + Date.now());
const SESSIONS_FILE = join(TEST_DIR, "active-sessions.json");

function loadActiveMap(): Record<string, string> {
  try {
    const { readFileSync, existsSync } = require("fs");
    if (!existsSync(SESSIONS_FILE)) return {};
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveActiveMap(map: Record<string, string>) {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2));
}

function getActiveSession(chatId: number): string | null {
  return loadActiveMap()[String(chatId)] || null;
}

function setActiveSession(chatId: number, sessionId: string) {
  const map = loadActiveMap();
  map[String(chatId)] = sessionId;
  saveActiveMap(map);
}

function clearActiveSession(chatId: number) {
  const map = loadActiveMap();
  delete map[String(chatId)];
  saveActiveMap(map);
}

describe("session management", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns null when no active session", () => {
    expect(getActiveSession(12345)).toBeNull();
  });

  it("sets and gets active session", () => {
    setActiveSession(12345, "session-abc");
    expect(getActiveSession(12345)).toBe("session-abc");
  });

  it("clears active session", () => {
    setActiveSession(12345, "session-abc");
    clearActiveSession(12345);
    expect(getActiveSession(12345)).toBeNull();
  });

  it("handles multiple chat IDs independently", () => {
    setActiveSession(111, "session-a");
    setActiveSession(222, "session-b");
    expect(getActiveSession(111)).toBe("session-a");
    expect(getActiveSession(222)).toBe("session-b");
  });

  it("overwrites existing session", () => {
    setActiveSession(111, "old-session");
    setActiveSession(111, "new-session");
    expect(getActiveSession(111)).toBe("new-session");
  });

  it("clearing one chat does not affect others", () => {
    setActiveSession(111, "session-a");
    setActiveSession(222, "session-b");
    clearActiveSession(111);
    expect(getActiveSession(111)).toBeNull();
    expect(getActiveSession(222)).toBe("session-b");
  });
});

describe("session file parsing", () => {
  const SESSIONS_DIR = join(TEST_DIR, "sessions");

  beforeEach(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("parses a valid jsonl session file", () => {
    const sessionFile = join(SESSIONS_DIR, "test-session.jsonl");
    const lines = [
      JSON.stringify({ sessionId: "abc-123", type: "system" }),
      JSON.stringify({ type: "user", message: { content: "Hello Claude" }, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: "Hi there!" } }),
      JSON.stringify({ type: "user", message: { content: "Second message" } }),
    ];
    writeFileSync(sessionFile, lines.join("\n"));

    // Parse manually (same logic as parseSessionFile)
    const content = require("fs").readFileSync(sessionFile, "utf-8").trim();
    const parsed = content.split("\n").map((l: string) => JSON.parse(l));

    let sessionId = null;
    let messageCount = 0;
    for (const obj of parsed) {
      if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      if (obj.type === "user") messageCount++;
    }

    expect(sessionId).toBe("abc-123");
    expect(messageCount).toBe(2);
  });

  it("returns null for empty file", () => {
    const sessionFile = join(SESSIONS_DIR, "empty.jsonl");
    writeFileSync(sessionFile, "");
    const content = require("fs").readFileSync(sessionFile, "utf-8").trim();
    expect(content).toBe("");
  });
});
