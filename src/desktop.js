import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { connectionConfiguration } from "./connection.js";

export function findClaudeDesktop({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const installed = [join(local, "AnthropicClaude", "claude.exe"), join(local, "Programs", "Claude", "Claude.exe")];
    if (installed.some((path) => exists(path))) {
      return { desktop: true, configPath: join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json") };
    }
  } else if (platform === "darwin" && ["/Applications/Claude.app", join(home, "Applications", "Claude.app")].some((path) => exists(path))) {
    return { desktop: true, configPath: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") };
  }
  return null;
}

class DesktopConfigurationError extends Error {}

function readConfiguration(path) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { source: null, config: {} };
    throw new DesktopConfigurationError("Could not read Claude desktop settings. Check file permissions and retry.");
  }
  let config;
  try { config = JSON.parse(source.replace(/^\uFEFF/, "")); }
  catch { throw new DesktopConfigurationError("Claude desktop settings contain invalid JSON. Fix them in Claude settings and retry. No settings were changed."); }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) {
    throw new DesktopConfigurationError("Claude desktop settings have an invalid structure. Fix them in Claude settings and retry. No settings were changed.");
  }
  return { source, config };
}

export function checkClaudeDesktopConfiguration(path) {
  readConfiguration(path);
}

export function configureClaudeDesktop(apiKey, apiUrl, { configPath, platform = process.platform } = {}) {
  const entry = connectionConfiguration(apiKey, apiUrl, platform);
  const lockPath = `${configPath}.caelario-install.lock`;
  const temporaryPath = `${configPath}.caelario-${randomUUID()}.tmp`;
  let lock;
  let temporaryCreated = false;
  try {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new DesktopConfigurationError("Another Caelario installer is updating Claude desktop settings. Let it finish and retry.");
      throw error;
    }
    const { source, config } = readConfiguration(configPath);
    const updated = { ...config, mcpServers: { ...config.mcpServers, caelario: entry } };
    const temporary = openSync(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try { writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`); }
    finally { closeSync(temporary); }
    if (readConfiguration(configPath).source !== source) {
      throw new DesktopConfigurationError("Claude desktop settings changed during installation. Run the installer again. No settings were overwritten.");
    }
    renameSync(temporaryPath, configPath);
    temporaryCreated = false;
  } catch (error) {
    if (error instanceof DesktopConfigurationError) throw error;
    throw new Error("Could not update Claude desktop settings. Close Claude, check file permissions and retry.");
  } finally {
    if (temporaryCreated) { try { unlinkSync(temporaryPath); } catch {} }
    if (lock !== undefined) {
      closeSync(lock);
      try { unlinkSync(lockPath); } catch {}
    }
  }
}
