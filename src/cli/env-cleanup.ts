import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Scans known .env file locations for lines setting ARKITEK_API_KEY.
 * Returns the paths of files that contain the key.
 */
export function findEnvKeyLocations(): string[] {
  const locations: string[] = [];
  const candidates = [
    join(process.cwd(), ".env"),
    join(homedir(), ".env"),
    join(homedir(), ".openclaw", "workspace", ".env"),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        let key = trimmed.split("=")[0]?.trim() ?? "";
        if (key.startsWith("export ")) key = key.slice(7).trim();
        if (key === "ARKITEK_API_KEY") {
          locations.push(envPath);
          break;
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return locations;
}

/**
 * Removes ARKITEK_API_KEY from a single .env file, preserving all other
 * variables and comments. Deletes the file entirely if no variables remain.
 */
export function removeApiKeyFromEnvFile(envPath: string): boolean {
  try {
    const content = readFileSync(envPath, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      let key = trimmed.split("=")[0]?.trim() ?? "";
      if (key.startsWith("export ")) key = key.slice(7).trim();
      return key !== "ARKITEK_API_KEY";
    });

    const newContent = filtered.join("\n");
    const remaining = filtered.filter((l) => l.trim() && !l.trim().startsWith("#"));

    if (remaining.length === 0) {
      unlinkSync(envPath);
    } else {
      writeFileSync(envPath, newContent, { mode: 0o600 });
    }

    return true;
  } catch {
    return false;
  }
}
