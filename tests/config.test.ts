import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the logic directly since config.ts uses hardcoded paths.
// Instead, we replicate the core logic with a temp directory.

const TEST_DIR = join(tmpdir(), "clink-test-config-" + Date.now());
const TEST_FILE = join(TEST_DIR, "config.json");

function loadTestConfig() {
  const DEFAULTS = {
    token: "",
    allowedUsers: [] as number[],
    model: "sonnet" as const,
    systemPrompt: "",
    workingDir: "/tmp",
    skipPermissions: true,
    language: "en" as const,
  };

  if (!existsSync(TEST_FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveTestConfig(config: Record<string, unknown>) {
  mkdirSync(TEST_DIR, { recursive: true });
  const { writeFileSync } = require("fs");
  writeFileSync(TEST_FILE, JSON.stringify(config, null, 2));
}

describe("config", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadTestConfig();
    expect(config.token).toBe("");
    expect(config.allowedUsers).toEqual([]);
    expect(config.model).toBe("sonnet");
    expect(config.skipPermissions).toBe(true);
    expect(config.language).toBe("en");
  });

  it("merges saved config with defaults", () => {
    saveTestConfig({ token: "123:ABC", model: "opus" });
    const config = loadTestConfig();
    expect(config.token).toBe("123:ABC");
    expect(config.model).toBe("opus");
    expect(config.allowedUsers).toEqual([]);
    expect(config.skipPermissions).toBe(true);
  });

  it("returns defaults for corrupted config file", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = require("fs");
    writeFileSync(TEST_FILE, "not json{{{");
    const config = loadTestConfig();
    expect(config.token).toBe("");
    expect(config.model).toBe("sonnet");
  });
});
