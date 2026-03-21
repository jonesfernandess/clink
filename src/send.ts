import TelegramBot from "node-telegram-bot-api";
import { createReadStream, existsSync, statSync } from "fs";
import { basename, extname } from "path";

const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const MAX_TEXT_LENGTH = 4096;

export function createBot(token: string): TelegramBot {
  return new TelegramBot(token, { polling: false });
}

export async function sendText(
  bot: TelegramBot,
  chatId: number,
  text: string,
): Promise<void> {
  if (!text || !text.trim()) return;
  const parts = splitText(text, MAX_TEXT_LENGTH);
  for (const part of parts) {
    await bot
      .sendMessage(chatId, part, { parse_mode: "Markdown" })
      .catch(() => bot.sendMessage(chatId, part));
  }
}

export async function sendFile(
  bot: TelegramBot,
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

  const ext = extname(filePath).toLowerCase();
  const stream = createReadStream(filePath);
  const opts = caption ? { caption } : {};

  if (PHOTO_EXTENSIONS.has(ext) && stat.size < 10 * 1024 * 1024) {
    await bot.sendPhoto(chatId, stream, opts);
  } else {
    await bot.sendDocument(chatId, stream, opts, {
      filename: basename(filePath),
    });
  }
}

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
