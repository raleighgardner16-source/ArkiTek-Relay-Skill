import { createInterface } from "node:readline";

function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY;
}

const COLOR = supportsColor();

const BOLD = COLOR ? "\x1b[1m" : "";
const DIM = COLOR ? "\x1b[2m" : "";
const RED = COLOR ? "\x1b[31m" : "";
const GREEN = COLOR ? "\x1b[32m" : "";
const YELLOW = COLOR ? "\x1b[33m" : "";
const CYAN = COLOR ? "\x1b[36m" : "";
const RESET = COLOR ? "\x1b[0m" : "";

export function success(msg: string): void {
  console.log(`  ${GREEN}\u2714${RESET} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}\u26A0${RESET} ${msg}`);
}

export function error(msg: string): void {
  console.error(`  ${RED}\u2716${RESET} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${CYAN}\u2139${RESET} ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${BOLD}${msg}${RESET}\n`);
}

export function step(n: number, total: number, msg: string): void {
  console.log(`\n  ${DIM}[${n}/${total}]${RESET} ${BOLD}${msg}${RESET}`);
}

export function dimmed(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on("close", () => {
      if (!answered) {
        answered = true;
        resolve("");
      }
    });
    rl.question(`  ${question}`, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`${question} ${suffix} `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}
