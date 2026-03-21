import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  ClinkConfig,
  SupportedLanguage,
  SessionEntry,
  ActiveSessionMap,
  ClaudeResult,
  IntentClassification,
  PendingApproval,
  GatewayStatus,
  Messages,
} from "../src/types.js";

describe("type definitions", () => {
  it("ClinkConfig has correct shape", () => {
    const config: ClinkConfig = {
      token: "123:ABC",
      allowedUsers: [111, 222],
      model: "sonnet",
      systemPrompt: "",
      workingDir: "/home/user",
      skipPermissions: true,
      language: "en",
    };
    expect(config.token).toBe("123:ABC");
    expect(config.allowedUsers).toHaveLength(2);
    expect(config.model).toBe("sonnet");
  });

  it("ClinkConfig model accepts valid values", () => {
    const models: ClinkConfig["model"][] = ["sonnet", "opus", "haiku"];
    expect(models).toHaveLength(3);
  });

  it("SupportedLanguage accepts valid values", () => {
    const langs: SupportedLanguage[] = ["en", "pt", "es"];
    expect(langs).toHaveLength(3);
  });

  it("SessionEntry has correct shape", () => {
    const entry: SessionEntry = {
      sessionId: "abc-123",
      firstPrompt: "Hello",
      summary: "Hello",
      messageCount: 5,
      created: "2026-01-01",
      modified: "2026-01-02",
      fullPath: "/path/to/session.jsonl",
    };
    expect(entry.sessionId).toBe("abc-123");
    expect(entry.messageCount).toBe(5);
  });

  it("ClaudeResult has correct shape", () => {
    const result: ClaudeResult = {
      text: "Hello world",
      files: ["/tmp/test.txt"],
    };
    expect(result.text).toBe("Hello world");
    expect(result.files).toHaveLength(1);
  });

  it("IntentClassification accepts valid values", () => {
    const intents: IntentClassification[] = ["chat", "action", "send_file"];
    expect(intents).toContain("chat");
    expect(intents).toContain("action");
    expect(intents).toContain("send_file");
  });

  it("GatewayStatus has correct shape", () => {
    const running: GatewayStatus = { running: true, pid: 1234 };
    const stopped: GatewayStatus = { running: false, pid: null };
    expect(running.pid).toBe(1234);
    expect(stopped.pid).toBeNull();
  });

  it("ActiveSessionMap maps string to string", () => {
    const map: ActiveSessionMap = {
      "12345": "session-abc",
      "67890": "session-def",
    };
    expect(map["12345"]).toBe("session-abc");
  });
});
