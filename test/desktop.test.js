import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findClaudeDesktop, configureClaudeDesktop, checkClaudeDesktopConfiguration } from "../src/desktop.js";
import { resolveClientExecutable } from "../src/client.js";
import { installClient } from "../src/install.js";
import { ConnectionKeyRejectedError } from "../src/onboarding.js";

const secret = "cae_test_current_12345";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "caelario-desktop-test-"));
  return { directory, configPath: join(directory, "Claude", "claude_desktop_config.json") };
}

test("Windows Claude desktop is found without running its GUI as a CLI", () => {
  const env = { LOCALAPPDATA: "C:/Local", APPDATA: "C:/Roaming" };
  const executable = join(env.LOCALAPPDATA, "AnthropicClaude", "claude.exe");
  const resolved = resolveClientExecutable("claude", {
    platform: "win32", env, home: "C:/Home", exists: (path) => path === executable,
    spawn: (command) => { assert.equal(command, "where.exe"); return { status: 1, stdout: "" }; },
  });
  assert.deepEqual(resolved, { desktop: true, configPath: join(env.APPDATA, "Claude", "claude_desktop_config.json") });
});

test("explicit desktop skips terminal discovery even if a CLI exists", () => {
  const env = { LOCALAPPDATA: "C:/Local", APPDATA: "C:/Roaming" };
  const found = resolveClientExecutable("claude-desktop", {
    platform: "win32", env, exists: () => true,
    spawn: () => assert.fail("Explicit desktop must not start a CLI or the GUI"),
  });
  assert.equal(found.desktop, true);
});

test("native Claude Code outside PATH is used before the desktop fallback", () => {
  const home = "C:/Home";
  const native = join(home, ".local", "bin", "claude.exe");
  const found = resolveClientExecutable("claude", {
    platform: "win32", env: {}, home, exists: (path) => path === native,
    spawn: (command) => command === "where.exe" ? { status: 1 } : { status: 0, stdout: "2.1.0 (Claude Code)" },
  });
  assert.deepEqual(found, { command: native, shell: false });
});

test("a GUI executable returning zero is not mistaken for Claude Code", () => {
  const env = { LOCALAPPDATA: "C:/Local", APPDATA: "C:/Roaming" };
  const gui = join(env.LOCALAPPDATA, "AnthropicClaude", "claude.exe");
  const found = resolveClientExecutable("claude", {
    platform: "win32", env, home: "C:/Home", exists: (path) => path === gui,
    spawn: (command) => command === "where.exe" ? { status: 0, stdout: gui } : { status: 0, stdout: "" },
  });
  assert.equal(found.desktop, true);
});

test("macOS desktop location and configuration are independent of the CLI", () => {
  const found = findClaudeDesktop({ platform: "darwin", home: "/home/test", exists: (path) => path === "/Applications/Claude.app" });
  assert.deepEqual(found, { desktop: true, configPath: join("/home/test", "Library", "Application Support", "Claude", "claude_desktop_config.json") });
});

test("desktop update preserves other servers and settings while replacing only Caelario", () => {
  const { configPath, directory } = fixture();
  mkdirSync(dirname(configPath));
  const original = { preferences: { locale: "en" }, customFlag: false, mcpServers: {
    other: { command: "unchanged", env: { SYNTHETIC_TOKEN: "keep-this-fixture" } },
    caelario: { command: "obsolete", env: { CAELARIO_API_KEY: "cae_test_expired_12345" } },
  } };
  writeFileSync(configPath, `\uFEFF${JSON.stringify(original)}`);
  configureClaudeDesktop(secret, "https://api.caelario.com", { configPath, platform: "win32" });
  const updated = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(updated.preferences, original.preferences);
  assert.equal(updated.customFlag, false);
  assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(updated.mcpServers.caelario, { command: "cmd", args: ["/c", "npx", "-y", "caelario-mcp", "serve"],
    env: { CAELARIO_API_KEY: secret, CAELARIO_API_URL: "https://api.caelario.com" } });
  assert.deepEqual(readdirSync(dirname(configPath)), ["claude_desktop_config.json"]);
  assert.deepEqual(readdirSync(directory), ["Claude"]);
});

test("new desktop configuration uses the macOS stdio launcher", () => {
  const { configPath } = fixture();
  configureClaudeDesktop(secret, "https://api.caelario.com", { configPath, platform: "darwin" });
  const entry = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.caelario;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "caelario-mcp", "serve"]);
});

test("invalid desktop settings are never overwritten and parser errors expose no content", () => {
  for (const source of ['{"secret":"keep-private",', "[]", "null", '{"mcpServers":[]}']) {
    const { configPath } = fixture();
    mkdirSync(dirname(configPath));
    writeFileSync(configPath, source);
    assert.throws(() => checkClaudeDesktopConfiguration(configPath), (error) => !error.message.includes("keep-private"));
    assert.throws(() => configureClaudeDesktop(secret, "https://api.caelario.com", { configPath }), /invalid/);
    assert.equal(readFileSync(configPath, "utf8"), source);
    assert.deepEqual(readdirSync(dirname(configPath)), ["claude_desktop_config.json"]);
  }
});

test("desktop installer lock prevents clobbering an active installation", () => {
  const { configPath } = fixture();
  mkdirSync(dirname(configPath));
  writeFileSync(configPath, "{}");
  writeFileSync(`${configPath}.caelario-install.lock`, "synthetic-lock");
  assert.throws(() => configureClaudeDesktop(secret, "https://api.caelario.com", { configPath }), /Another Caelario installer/);
  assert.equal(readFileSync(configPath, "utf8"), "{}");
  assert.equal(readFileSync(`${configPath}.caelario-install.lock`, "utf8"), "synthetic-lock");
});

test("desktop configuration enforces safe keys and API origins before creating files", () => {
  const { configPath, directory } = fixture();
  assert.throws(() => configureClaudeDesktop("bad key", "https://api.caelario.com", { configPath }), /format/);
  assert.throws(() => configureClaudeDesktop(secret, "http://example.com", { configPath }), /HTTPS/);
  assert.deepEqual(readdirSync(directory), []);
});

test("desktop fallback validates replacement key before writing and never calls the CLI", async () => {
  const { configPath } = fixture();
  const output = [];
  const events = [];
  await installClient("claude", {
    apiKey: "cae_test_expired_12345", interactive: true, platform: "win32",
    resolveClient: () => ({ desktop: true, configPath }),
    write: (text) => output.push(text),
    openBrowser: () => events.push("browser"),
    prompt: async () => { events.push("prompt"); return secret; },
    verifyKey: async (key) => {
      events.push("verify");
      if (key !== secret) throw new ConnectionKeyRejectedError();
    },
    spawn: () => assert.fail("Desktop fallback must not need a separate CLI"),
  });
  assert.deepEqual(events, ["verify", "browser", "prompt", "verify"]);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.caelario.env.CAELARIO_API_KEY, secret);
  assert.ok(!output.join("").includes(secret));
  assert.ok(output.join("").includes("Quit Claude completely"));
});

test("rejected desktop key leaves existing configuration untouched", async () => {
  const { configPath } = fixture();
  mkdirSync(dirname(configPath));
  const original = JSON.stringify({ preferences: { theme: "dark" } });
  writeFileSync(configPath, original);
  await assert.rejects(installClient("claude-desktop", {
    apiKey: secret, interactive: false, write: () => {},
    resolveClient: () => ({ desktop: true, configPath }),
    verifyKey: async () => { throw new ConnectionKeyRejectedError(); },
  }), ConnectionKeyRejectedError);
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("invalid desktop configuration fails before requesting a connection key", async () => {
  const { configPath } = fixture();
  mkdirSync(dirname(configPath));
  writeFileSync(configPath, "not-json");
  await assert.rejects(installClient("claude-desktop", {
    apiKey: "", interactive: true, write: () => {},
    resolveClient: () => ({ desktop: true, configPath }),
    prompt: () => assert.fail("Do not prompt when settings are already invalid"),
    verifyKey: () => assert.fail("Do not check a key when settings are invalid"),
  }), /invalid JSON/);
});

test("public help advertises explicit Claude desktop installation", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/caelario-mcp.js", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.ok(result.stderr.includes("install claude-desktop"));
});
