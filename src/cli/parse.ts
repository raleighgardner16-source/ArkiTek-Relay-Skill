import type { CLICommand, CLIOptions } from "../types.js";
import { LOG_PREFIX } from "../types.js";

export function parseArgs(argv: string[]): CLIOptions {
  const args = argv.slice(2);

  let command: CLICommand = "start";
  const options: Partial<CLIOptions> = {};

  function requireValue(flag: string, index: number): string {
    const val = args[index];
    if (val === undefined || val.startsWith("--")) {
      console.error(`Error: ${flag} requires a value`);
      process.exit(1);
    }
    return val;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--install":
        command = "install";
        break;
      case "--doctor":
      case "--check":
        command = "doctor";
        break;
      case "--status":
        command = "status";
        break;
      case "--logs":
        command = "logs";
        break;
      case "--uninstall":
        command = "uninstall";
        break;
      case "--init-skill":
        command = "init-skill";
        break;
      case "--help":
      case "-h":
        command = "help";
        break;
      case "--api-key":
        options.apiKey = requireValue(arg, ++i);
        console.warn(
          `${LOG_PREFIX} Warning: --api-key exposes the key in your process list. ` +
            "Prefer ARKITEK_API_KEY env var or the persisted config (--install) for better security.",
        );
        break;
      case "--gateway-url":
        options.gatewayUrl = requireValue(arg, ++i);
        break;
      case "--gateway-token":
        options.gatewayToken = requireValue(arg, ++i);
        break;
      case "--agent-id":
        options.agentId = requireValue(arg, ++i);
        break;
      case "--skills-dir":
        options.skillsDir = requireValue(arg, ++i);
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--verbose":
      case "-v":
        break;
      default:
        if (arg.startsWith("--")) {
          console.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return { command, ...options } as CLIOptions;
}

export function printHelp(): void {
  console.log(`
  arkitek-relay-skill \u2014 Connect your OpenClaw agent to ArkiTek

  Usage:
    npx arkitek-relay-skill [command] [options]

  Commands:
    (default)    Start the relay (runs guided setup on first use)
    --install    Run guided setup (detect OpenClaw, configure, save)
    --init-skill Place SKILL.md into OpenClaw's skills directory
    --doctor     Run diagnostic checks on your setup
    --status     Show saved configuration
    --logs       View relay log output
    --uninstall  Remove saved config and system service
    --help       Show this help message

  Options:
    --api-key <key>         ArkiTek API key (overrides saved config)
    --gateway-url <url>     OpenClaw gateway URL (overrides auto-detection)
    --gateway-token <token> OpenClaw gateway auth token
    --agent-id <id>         OpenClaw agent ID (default: "main")
    --skills-dir <path>     Custom OpenClaw skills directory
    --yes, -y               Skip confirmation prompts
`);
}
