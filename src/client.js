import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findClaudeDesktop } from "./desktop.js";

export function resolveClientExecutable(client, {
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
  home = homedir(),
} = {}) {
  if (!["codex", "claude", "claude-desktop"].includes(client)) throw new Error("client must be codex, claude or claude-desktop");
  if (client === "claude-desktop") {
    const desktop = findClaudeDesktop({ platform, env, home, exists });
    if (desktop) return desktop;
    throw new Error("Claude desktop was not found. Install and open Claude desktop, then run this command again.");
  }
  const options = { encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 10_000 };
  const usable = (path) => {
    const shell = platform === "win32" && /\.(cmd|bat)$/i.test(path);
    const command = shell ? `"${path}"` : path;
    const result = spawn(command, ["--version"], { ...options, shell });
    if (result.error || result.status !== 0) return null;
    if (client === "claude" && !/\bClaude Code\b|^\s*\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s|$)/i.test(result.stdout || "")) return null;
    return { command, shell };
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
  if (client === "claude") {
    const candidates = [join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude")];
    if (platform === "win32" && env.APPDATA) candidates.push(join(env.APPDATA, "npm", "claude.cmd"));
    for (const path of candidates) {
      if (exists(path)) {
        const found = usable(path);
        if (found) return found;
      }
    }
    const desktop = findClaudeDesktop({ platform, env, home, exists });
    if (desktop) return desktop;
  }
  throw new Error(client === "codex"
    ? "Codex was not found. Install the Codex desktop app or Codex CLI, then run this command again."
    : "Neither Claude Code nor Claude desktop was found. Install either one, then run this command again.");
}
