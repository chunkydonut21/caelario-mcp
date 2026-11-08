import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveClientExecutable(client, {
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
} = {}) {
  if (!["codex", "claude"].includes(client)) throw new Error("client must be codex or claude");
  const options = { encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 10_000 };
  const usable = (path) => {
    const shell = platform === "win32" && /\.(cmd|bat)$/i.test(path);
    const command = shell ? `"${path}"` : path;
    const result = spawn(command, ["--version"], { ...options, shell });
    return !result.error && result.status === 0 ? { command, shell } : null;
  };
  if (platform !== "win32") {
    const found = usable(client);
    if (found) return found;
  } else {
    const located = spawn("where.exe", [client], options);
    if (!located.error && located.status === 0) {
      for (const path of (located.stdout || "").trim().split(/\r?\n/)) {
        if (path && exists(path)) {
          const found = usable(path);
          if (found) return found;
        }
      }
    }
    if (client === "codex") {
      // Desktop installs include a CLI even when a normal terminal cannot find it.
      const powershell = join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const app = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        "Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.InstallLocation 'app\\resources\\codex.exe' }",
      ], options);
      const candidates = !app.error && app.status === 0 ? (app.stdout || "").trim().split(/\r?\n/) : [];
      if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Codex", "resources", "codex.exe"));
      if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "Codex", "resources", "codex.exe"));
      for (const path of candidates) {
        if (path && exists(path)) {
          const found = usable(path);
          if (found) return found;
        }
      }
    }
  }
  throw new Error(client === "codex"
    ? "Codex was not found. Install the Codex desktop app or Codex CLI, then run this command again."
    : "Claude Code was not found. Install Claude Code, then run this command again.");
}
