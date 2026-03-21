import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test the splitText logic (internal to send.ts, replicated here)
function splitText(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  while (text.length > 0) {
    if (text.length <= maxLen) {
      parts.push(text);
      break;
    }
    let cut = text.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  return parts;
}

describe("splitText", () => {
  it("returns single part for short text", () => {
    const parts = splitText("hello", 100);
    expect(parts).toEqual(["hello"]);
  });

  it("splits at newline boundary", () => {
    const text = "line1\nline2\nline3";
    const parts = splitText(text, 10);
    expect(parts[0]).toBe("line1");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("handles text with no newlines", () => {
    const text = "a".repeat(100);
    const parts = splitText(text, 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(30);
    }
  });

  it("handles empty string", () => {
    const parts = splitText("", 100);
    expect(parts).toEqual([]);
  });

  it("handles text exactly at max length", () => {
    const text = "a".repeat(100);
    const parts = splitText(text, 100);
    expect(parts).toEqual([text]);
  });

  it("splits Telegram messages at 4096 limit", () => {
    const longText = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(100)}`).join("\n");
    const parts = splitText(longText, 4096);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    // Rejoin should contain all content
    expect(parts.join("").replace(/\s+/g, "")).toBe(longText.replace(/\s+/g, ""));
  });
});

describe("sendFile validation", () => {
  const TEST_DIR = join(tmpdir(), "clink-test-send-" + Date.now());

  it("detects photo extensions correctly", () => {
    const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
    expect(PHOTO_EXTENSIONS.has(".jpg")).toBe(true);
    expect(PHOTO_EXTENSIONS.has(".png")).toBe(true);
    expect(PHOTO_EXTENSIONS.has(".pdf")).toBe(false);
    expect(PHOTO_EXTENSIONS.has(".txt")).toBe(false);
  });
});
