#!/usr/bin/env node

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

console.log(`
  ${BOLD}${CYAN}arkitek-relay-skill${RESET} installed!

  Run this to set up and connect your agent:

    ${YELLOW}npx arkitek-relay-skill${RESET}

  ${DIM}The installer will auto-detect your OpenClaw config, prompt for
  your API key, and connect your agent to ArkiTek.${RESET}

  ${DIM}Run diagnostics anytime:  npx arkitek-relay-skill --doctor${RESET}
  ${DIM}See all commands:          npx arkitek-relay-skill --help${RESET}
`);
