import { describe, it, expect } from "vitest";
import { t, LANGUAGE_NAMES } from "../src/i18n.js";

describe("i18n", () => {
  it("returns English messages by default", () => {
    const msg = t("en");
    expect(msg.intro).toBe("Claude Code on your phone via Telegram");
    expect(msg.menuStart).toBe("Start gateway");
  });

  it("returns Portuguese messages", () => {
    const msg = t("pt");
    expect(msg.intro).toBe("Claude Code no seu celular via Telegram");
    expect(msg.menuStart).toBe("Iniciar gateway");
  });

  it("returns Spanish messages", () => {
    const msg = t("es");
    expect(msg.intro).toBe("Claude Code en tu celular via Telegram");
    expect(msg.menuStart).toBe("Iniciar gateway");
  });

  it("falls back to English for unknown language", () => {
    const msg = t("fr");
    expect(msg.intro).toBe("Claude Code on your phone via Telegram");
  });

  it("has all three languages in LANGUAGE_NAMES", () => {
    expect(LANGUAGE_NAMES.en).toBe("English");
    expect(LANGUAGE_NAMES.pt).toBe("Portuguese");
    expect(LANGUAGE_NAMES.es).toBe("Spanish");
  });

  it("function properties work correctly", () => {
    const msg = t("en");
    expect(msg.userCount(3)).toBe("3 user(s)");
    expect(msg.modelChanged("opus")).toBe("Model changed to opus");
    expect(msg.wizardStep(1, 3)).toBe("Step 1/3");
    expect(msg.gatewayBlocked(123, "john")).toBe("[BLOCKED] user 123 (john)");
    expect(msg.sendFileNotFound("/tmp/x")).toBe("File not found: /tmp/x");
  });

  it("PT function properties work correctly", () => {
    const msg = t("pt");
    expect(msg.userCount(5)).toBe("5 usuario(s)");
    expect(msg.wizardStep(2, 3)).toBe("Passo 2/3");
  });

  it("ES function properties work correctly", () => {
    const msg = t("es");
    expect(msg.userCount(1)).toBe("1 usuario(s)");
    expect(msg.wizardStep(3, 3)).toBe("Paso 3/3");
  });

  it("all languages have disclaimer strings", () => {
    for (const lang of ["en", "pt", "es"]) {
      const msg = t(lang);
      expect(msg.disclaimerTitle).toBeTruthy();
      expect(msg.disclaimerConfirm).toBeTruthy();
      expect(msg.disclaimerCancelled).toBeTruthy();
    }
  });

  it("all languages have the same set of keys", () => {
    const en = t("en");
    const pt = t("pt");
    const es = t("es");
    const enKeys = Object.keys(en).sort();
    const ptKeys = Object.keys(pt).sort();
    const esKeys = Object.keys(es).sort();
    expect(ptKeys).toEqual(enKeys);
    expect(esKeys).toEqual(enKeys);
  });
});
