import { spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { resolveClientExecutable } from "./client.js";
import { SETUP_URL, setupInstructions, openSetupPage, verifyWorkspaceKey, ConnectionKeyRejectedError } from "./onboarding.js";

const CLIENTS = new Set(["codex", "claude"]);
const KEY_PATTERN = /^[A-Za-z0-9._-]{16,256}$/;

export function registrationCommand(client, apiKey, apiUrl = "https://api.caelario.com", platform = process.platform) {
  if (!CLIENTS.has(client)) throw new Error("client must be codex or claude");
  if (!KEY_PATTERN.test(apiKey)) throw new Error("the Caelario API key format is invalid");
  const origin = new URL(apiUrl);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("the Caelario API URL requires HTTP or HTTPS");
  if (/[&|<>^%!()\r\n]/.test(origin.origin)) throw new Error("the Caelario API origin contains unsafe launcher characters");
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("the Caelario API URL must use HTTPS");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("the Caelario API URL must contain only an origin");
  }

  const launcher = platform === "win32"
    ? ["cmd", "/c", "npx", "-y", "caelario-mcp", "serve"]
    : ["npx", "-y", "caelario-mcp", "serve"];
  const common = [
    "mcp", "add",
    ...(client === "claude" ? ["--scope", "user"] : []),
    "caelario",
    "--env", `CAELARIO_API_URL=${origin.origin}`,
    "--env", `CAELARIO_API_KEY=${apiKey}`,
    "--",
    ...launcher,
  ];
  return { command: client, args: common };
}

export async function installClient(
  client,
  {
    apiKey = process.env.CAELARIO_API_KEY,
    apiUrl = process.env.CAELARIO_API_URL || "https://api.caelario.com",
    platform = process.platform,
    spawn = spawnSync,
    resolveClient = resolveClientExecutable,
    openBrowser = openSetupPage,
    prompt = promptSecret,
    verifyKey = verifyWorkspaceKey,
    write = (text) => process.stderr.write(text),
    interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  } = {},
) {
  if (!CLIENTS.has(client)) throw new Error("client must be codex or claude");
  write(`Finding ${client === "codex" ? "Codex" : "Claude Code"}...\n`);
  const executable = resolveClient(client, { platform });
  let key = apiKey?.trim();
  let setupShown = false;
  let registration;
  if (key) write("Found CAELARIO_API_KEY in your environment.\n");
  while (true) {
    if (!key) {
      if (!setupShown) {
        write(`${setupInstructions(client)}\n\n`);
        if (interactive) {
          write("Opening your browser setup page...\n");
          openBrowser();
        }
        setupShown = true;
      }
      if (!interactive) {
        throw new Error(`Open ${SETUP_URL} to create your account and connection key. Run the installer in an interactive terminal, or set CAELARIO_API_KEY in your private MCP configuration.`);
      }
      key = (await prompt("Finish setup in your browser, then paste your connection key here: ")).trim();
    }
    if (!KEY_PATTERN.test(key)) {
      if (!interactive) throw new Error(`The connection key format is invalid. Get your full key at ${SETUP_URL}.`);
      write("That connection key is incomplete or has an invalid format. Paste the full key from browser setup.\n");
      key = "";
      continue;
    }
    // Validate the origin before sending a key, even when setup needs a retry.
    registration = registrationCommand(client, key, apiUrl, platform);
    write("Checking your Caelario connection key...\n");
    try {
      await verifyKey(key, apiUrl);
      break;
    } catch (error) {
      if (!(error instanceof ConnectionKeyRejectedError) || !interactive) throw error;
      write("Caelario did not accept that key. Let's connect with a current key from browser setup.\n");
      key = "";
    }
  }
  const completed = spawn(executable.command, registration.args, {
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    shell: executable.shell,
  });
  for (const output of [completed.stdout, completed.stderr]) {
    if (output) write(output.replaceAll(key, "[redacted]"));
  }
  if (completed.error?.code === "ENOENT") {
    throw new Error(`${client === "codex" ? "Codex" : "Claude Code"} was not found. Reopen your terminal and run this command again.`);
  }
  if (completed.error) throw new Error("The assistant client could not be started. Check its installation and run this command again.");
  if (completed.status !== 0) {
    throw new Error(`${client === "codex" ? "Codex" : "Claude Code"} rejected the MCP registration (exit ${completed.status ?? "unknown"})`);
  }
  write(`Caelario is connected to ${client === "codex" ? "Codex" : "Claude Code"}. Restart the client, then ask it to use Caelario.\n`);
}

async function promptSecret(prompt) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`Open ${SETUP_URL} to create your account and connection key. Run the installer in an interactive terminal, or set CAELARIO_API_KEY in your private MCP configuration.`);
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("installation cancelled"));
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

export function printHelp() {
  const output = [
    "Caelario MCP",
    "",
    "  npx -y caelario-mcp install codex   Register for Codex (user-wide)",
    "  npx -y caelario-mcp install claude  Register for Claude Code (user-wide)",
    "  npx -y caelario-mcp serve           Run the stdio server",
    "",
    setupInstructions(),
  ];
  readline.clearLine(process.stderr, 0);
  process.stderr.write(`${output.join("\n")}\n`);
}
