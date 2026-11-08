import { spawn } from "node:child_process";

export const SETUP_URL = "https://app.caelario.com/connect";
export const SIGNUP_URL = "https://app.caelario.com/sign-up";

export function setupInstructions(client = "codex") {
  const label = client === "claude" ? "Claude Code" : "Codex";
  return [
    "Caelario connects social media data to your AI assistant.",
    "",
    `1. Open ${SETUP_URL}`,
    "2. Create a free account (or sign in), then create your connection key.",
    `3. Return here, paste the key when asked, then restart ${label}.`,
    "",
    "The browser setup page guides you through every step. Keep the key out of chat.",
  ].join("\n");
}

export function openSetupPage() {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", SETUP_URL]]
    : process.platform === "darwin" ? ["open", [SETUP_URL]] : ["xdg-open", [SETUP_URL]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* The printed URL remains usable when a browser cannot be opened. */ }
}

export class ConnectionKeyRejectedError extends Error {
  constructor() {
    super(`Caelario did not accept that key. Open ${SETUP_URL}, copy your full connection key and try again.`);
    this.name = "ConnectionKeyRejectedError";
  }
}

export async function verifyWorkspaceKey(apiKey, apiUrl) {
  let response;
  try {
    response = await fetch(new URL("/v1/account", apiUrl), {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Could not reach Caelario to check the key. Check your connection and run the installer again.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectionKeyRejectedError();
  }
  if (!response.ok) throw new Error("Caelario could not verify the key right now. Please try again shortly.");
  const account = await response.json().catch(() => null);
  if (!account || typeof account.organization_id !== "string") {
    throw new Error("Caelario returned an unexpected response while checking the key. Please try again shortly.");
  }
}
