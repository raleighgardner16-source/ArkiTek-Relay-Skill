import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { getLogPath, getErrorLogPath } from "../config/resolver.js";
import * as ui from "./ui.js";

const TAIL_LINES = 50;
const TAIL_CHUNK_SIZE = 64 * 1024; // 64KB — enough for ~50 lines in most cases

export async function runLogs(): Promise<void> {
  const logPath = getLogPath();
  const errorLogPath = getErrorLogPath();

  ui.heading("ArkiTek Relay \u2014 Logs");

  let found = false;

  for (const [label, filePath] of [
    ["Output", logPath],
    ["Errors", errorLogPath],
  ] as const) {
    if (existsSync(filePath)) {
      found = true;
      const stat = statSync(filePath);
      ui.info(`${label} log: ${filePath} (${formatSize(stat.size)})`);

      const tail = readTail(filePath, stat.size);
      if (tail) {
        console.log();
        console.log(tail);
      } else {
        ui.dimmed("  (empty)");
      }
      console.log();
    }
  }

  if (!found) {
    ui.info("No log files found.");
    ui.dimmed(`Expected at: ${logPath}`);
    ui.dimmed(
      "Logs are created when the relay runs as a system service.",
    );
    ui.dimmed("When running in the terminal, output goes to stdout.");
  }
}

function readTail(filePath: string, fileSize: number): string {
  if (fileSize === 0) return "";

  const chunkSize = Math.min(fileSize, TAIL_CHUNK_SIZE);
  const buffer = Buffer.alloc(chunkSize);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, chunkSize, Math.max(0, fileSize - chunkSize));
  } finally {
    closeSync(fd);
  }

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");

  if (fileSize > chunkSize) {
    lines.shift();
  }

  return lines.slice(-TAIL_LINES).join("\n").trim();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
