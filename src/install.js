import { spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { SETUP_URL, setupInstructions, openSetupPage, verifyWorkspaceKey } from "./onboarding.js";

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
    openBrowser = openSetupPage,
    prompt = promptSecret,
    verifyKey = verifyWorkspaceKey,
    write = (text) => process.stderr.write(text),
    interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  } = {},
) {
  if (!CLIENTS.has(client)) throw new Error("client must be codex or claude");
  let key = apiKey?.trim();
  if (!key) {
    write(`${setupInstructions(client)}\n\n`);
    if (interactive) {
      write("Opening your browser setup page...\n");
      openBrowser();
    }
    key = await prompt("Finish setup in your browser, then paste your connection key here: ");
  }
  const registration = registrationCommand(client, key, apiUrl, platform);
  write("Checking your Caelario connection key...\n");
  await verifyKey(key, apiUrl);
  const completed = spawn(registration.command, registration.args, {
    stdio: "inherit",
    windowsHide: true,
    shell: platform === "win32",
  });
  if (completed.error?.code === "ENOENT") {
    throw new Error(`${client === "codex" ? "Codex" : "Claude Code"} CLI was not found. Install it, then run this command again.`);
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
