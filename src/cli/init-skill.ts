import type { CLIOptions } from "../types.js";
import {
  detectOpenClaw,
  findInstalledSkill,
  installSkillFile,
  getDefaultSkillsDir,
  getBundledSkillPath,
} from "../config/openclaw.js";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import * as ui from "./ui.js";

export async function runInitSkill(cli: CLIOptions): Promise<void> {
  ui.heading("ArkiTek Relay — Install Skill Definition");

  const bundledPath = getBundledSkillPath();
  if (!existsSync(bundledPath)) {
    ui.error("Bundled SKILL.md not found in the package.");
    ui.dimmed("Try reinstalling: npm install -g arkitek-relay-skill");
    process.exit(1);
  }
  ui.success("Bundled SKILL.md located");

  const openclaw = detectOpenClaw();
  if (openclaw) {
    ui.success(`OpenClaw detected at ${openclaw.configPath}`);
  } else {
    ui.warn("OpenClaw config not found at ~/.openclaw/openclaw.json");
    ui.dimmed("The skill file will still be placed in the default location.");
  }

  const targetDir = cli.skillsDir || getDefaultSkillsDir();
  ui.info(`Target directory: ${targetDir}/arkitek-relay/`);

  const existing = findInstalledSkill();
  if (existing) {
    ui.warn(`Existing SKILL.md found at ${existing}`);

    let shouldOverwrite = cli.yes;
    if (!shouldOverwrite && process.stdin.isTTY) {
      shouldOverwrite = await ui.confirm("Overwrite with the latest version?");
    }

    if (!shouldOverwrite) {
      ui.dimmed("Skipped. Existing SKILL.md left in place.");
      return;
    }
  }

  try {
    const targetOverride = cli.skillsDir || (existing ? dirname(dirname(existing)) : undefined);
    const result = installSkillFile(targetOverride);
    ui.success(
      result.existed
        ? `SKILL.md updated at ${result.path}`
        : `SKILL.md installed at ${result.path}`,
    );
    console.log();
    ui.info("OpenClaw will discover this skill automatically on next load.");
    ui.dimmed("To verify: openclaw skills list");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(`Failed to install SKILL.md: ${msg}`);
    ui.dimmed("Try specifying a custom directory with --skills-dir <path>");
    process.exit(1);
  }
}
