import { describe, it, expect } from "vitest";

// Test the SEND_FILE tag parsing logic (from bot.ts message handler)
function parseSendFileTags(response: string): string[] {
  return [...response.matchAll(/\[SEND_FILE:([^\]]+)\]/g)].map((m) => {
    const raw = m[1].trim();
    const parts = raw.split(":");
    if (parts.length >= 2 && /^-?\d+$/.test(parts[0].trim()) && parts[1].startsWith("/")) {
      return parts.slice(1).join(":").trim();
    }
    return raw;
  });
}

function parseSendToTags(response: string): Array<{ targetChatId: number; message: string }> {
  return [...response.matchAll(/\[SEND_TO:(-?\d+):([^\]]+)\]/g)].map((m) => ({
    targetChatId: Number(m[1]),
    message: m[2].trim(),
  }));
}

function parseSendFileToTags(response: string): Array<{ targetChatId: number; filePath: string; caption?: string }> {
  return [...response.matchAll(/\[SEND_FILE_TO:(-?\d+):([^:\]]+)(?::([^\]]*))?\]/g)].map((m) => ({
    targetChatId: Number(m[1]),
    filePath: m[2].trim(),
    caption: m[3]?.trim() || undefined,
  }));
}

describe("SEND_FILE tag parsing", () => {
  it("parses correct [SEND_FILE:/path] tag", () => {
    const tags = parseSendFileTags("Here is your file [SEND_FILE:/Users/jones/Desktop/test.txt]");
    expect(tags).toEqual(["/Users/jones/Desktop/test.txt"]);
  });

  it("handles wrong format [SEND_FILE:chatid:/path]", () => {
    const tags = parseSendFileTags("[SEND_FILE:5348052704:/Users/jones/Desktop/test2.txt]");
    expect(tags).toEqual(["/Users/jones/Desktop/test2.txt"]);
  });

  it("handles negative chat ID in wrong format", () => {
    const tags = parseSendFileTags("[SEND_FILE:-1001234567890:/home/user/file.pdf]");
    expect(tags).toEqual(["/home/user/file.pdf"]);
  });

  it("parses multiple SEND_FILE tags", () => {
    const response = "Files: [SEND_FILE:/tmp/a.txt] and [SEND_FILE:/tmp/b.txt]";
    const tags = parseSendFileTags(response);
    expect(tags).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  });

  it("returns empty array when no tags", () => {
    const tags = parseSendFileTags("Just a normal response without tags");
    expect(tags).toEqual([]);
  });

  it("handles path with spaces", () => {
    const tags = parseSendFileTags("[SEND_FILE:/Users/jones/My Documents/file.txt]");
    expect(tags).toEqual(["/Users/jones/My Documents/file.txt"]);
  });
});

describe("SEND_TO tag parsing", () => {
  it("parses [SEND_TO:chatId:message]", () => {
    const tags = parseSendToTags("[SEND_TO:123456789:Hello from the bot!]");
    expect(tags).toEqual([{ targetChatId: 123456789, message: "Hello from the bot!" }]);
  });

  it("parses negative group ID", () => {
    const tags = parseSendToTags("[SEND_TO:-1001234567890:Report ready]");
    expect(tags).toEqual([{ targetChatId: -1001234567890, message: "Report ready" }]);
  });

  it("parses multiple SEND_TO tags", () => {
    const response = "[SEND_TO:111:Hello] text [SEND_TO:222:World]";
    const tags = parseSendToTags(response);
    expect(tags).toHaveLength(2);
    expect(tags[0].targetChatId).toBe(111);
    expect(tags[1].targetChatId).toBe(222);
  });
});

describe("SEND_FILE_TO tag parsing", () => {
  it("parses [SEND_FILE_TO:chatId:/path]", () => {
    const tags = parseSendFileToTags("[SEND_FILE_TO:123456789:/home/user/report.pdf]");
    expect(tags).toEqual([{
      targetChatId: 123456789,
      filePath: "/home/user/report.pdf",
      caption: undefined,
    }]);
  });

  it("parses with caption [SEND_FILE_TO:chatId:/path:caption]", () => {
    const tags = parseSendFileToTags("[SEND_FILE_TO:-1001234567890:/home/user/image.png:Here is the chart]");
    expect(tags).toEqual([{
      targetChatId: -1001234567890,
      filePath: "/home/user/image.png",
      caption: "Here is the chart",
    }]);
  });

  it("returns empty array when no tags", () => {
    const tags = parseSendFileToTags("No tags here");
    expect(tags).toEqual([]);
  });
});

describe("response cleaning", () => {
  it("strips all special tags from response", () => {
    const response = "Hello! [SEND_FILE:/tmp/test.txt] Check [SEND_TO:123:Hi] and [SEND_FILE_TO:456:/tmp/x.pdf] done.";
    const clean = response
      .replace(/\[SEND_FILE:[^\]]+\]/g, "")
      .replace(/\[SEND_TO:-?\d+:[^\]]+\]/g, "")
      .replace(/\[SEND_FILE_TO:-?\d+:[^\]]+\]/g, "")
      .trim();
    expect(clean).toBe("Hello!  Check  and  done.");
  });
});

describe("intent classification mapping", () => {
  function classifyResult(raw: string): "chat" | "action" | "send_file" {
    const result = raw.toUpperCase();
    if (result.includes("SEND_FILE") || result.includes("SEND FILE")) return "send_file";
    if (result.includes("CHAT") && !result.includes("ACTION")) return "chat";
    return "action";
  }

  it("classifies CHAT correctly", () => {
    expect(classifyResult("CHAT")).toBe("chat");
    expect(classifyResult("chat")).toBe("chat");
  });

  it("classifies ACTION correctly", () => {
    expect(classifyResult("ACTION")).toBe("action");
    expect(classifyResult("action")).toBe("action");
  });

  it("classifies SEND_FILE correctly", () => {
    expect(classifyResult("SEND_FILE")).toBe("send_file");
    expect(classifyResult("SEND FILE")).toBe("send_file");
    expect(classifyResult("send_file")).toBe("send_file");
  });

  it("defaults to action for ambiguous input", () => {
    expect(classifyResult("CHAT ACTION")).toBe("action");
    expect(classifyResult("unknown")).toBe("action");
    expect(classifyResult("")).toBe("action");
  });

  it("SEND_FILE takes priority over CHAT", () => {
    expect(classifyResult("CHAT SEND_FILE")).toBe("send_file");
  });
});

describe("destructive operation detection", () => {
  const destructivePattern = /\b(rm\s|rm\b|remov|delet|apag|exclu|elimin|drop\s|drop\b|wipe|limpar|borrar|format)/i;

  function isDestructive(text: string): boolean {
    return destructivePattern.test(text);
  }

  it("detects rm commands", () => {
    expect(isDestructive("rm /tmp/test.txt")).toBe(true);
    expect(isDestructive("quero que remova os 2")).toBe(true);
  });

  it("detects delete in English", () => {
    expect(isDestructive("delete that file")).toBe(true);
    expect(isDestructive("remove the folder")).toBe(true);
  });

  it("detects delete in Portuguese", () => {
    expect(isDestructive("apague o arquivo")).toBe(true);
    expect(isDestructive("exclua isso")).toBe(true);
    expect(isDestructive("elimine os logs")).toBe(true);
  });

  it("detects delete in Spanish", () => {
    expect(isDestructive("borrar el archivo")).toBe(true);
    expect(isDestructive("eliminar todo")).toBe(true);
  });

  it("detects other destructive keywords", () => {
    expect(isDestructive("drop the database")).toBe(true);
    expect(isDestructive("wipe the disk")).toBe(true);
    expect(isDestructive("format the drive")).toBe(true);
    expect(isDestructive("limpar tudo")).toBe(true);
  });

  it("does not flag safe operations", () => {
    expect(isDestructive("crie um arquivo")).toBe(false);
    expect(isDestructive("list files")).toBe(false);
    expect(isDestructive("show me the readme")).toBe(false);
    expect(isDestructive("qual é a previsão do tempo")).toBe(false);
    expect(isDestructive("edit the config")).toBe(false);
  });
});
