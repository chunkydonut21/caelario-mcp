import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { registrationCommand, installClient as runInstallClient } from "../src/install.js";
import { SETUP_URL, verifyWorkspaceKey, ConnectionKeyRejectedError } from "../src/onboarding.js";
import { spawnSync } from "node:child_process";
import { resolveClientExecutable } from "../src/client.js";

const installClient = (client, options) => runInstallClient(client, {
  resolveClient: (name) => ({ command: name, shell: false }), ...options,
});

test("package and MCP Registry metadata identify the same server", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
  assert.equal(packageJson.mcpName, "io.github.chunkydonut21/caelario");
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.websiteUrl, "https://caelario.com/mcp-server");
  assert.equal(serverJson.packages[0].identifier, packageJson.name);
  assert.equal(serverJson.packages[0].version, packageJson.version);
  assert.equal(serverJson.packages[0].transport.type, "stdio");
  assert.deepEqual(serverJson.packages[0].environmentVariables, [{
    description: "Get your Caelario account and connection key at https://app.caelario.com/connect. The browser setup guides you through registration and connection.",
    isRequired: true,
    format: "string",
    isSecret: true,
    name: "CAELARIO_API_KEY",
  }]);
});

test("builds user-wide Codex and Claude registrations", () => {
  const key = "cae_test_1234567890";
  const codex = registrationCommand("codex", key, "https://api.caelario.com", "linux");
  assert.deepEqual(codex.args.slice(0, 3), ["mcp", "add", "caelario"]);
  assert.deepEqual(codex.args.slice(-4), ["npx", "-y", "caelario-mcp", "serve"]);
  const claude = registrationCommand("claude", key, "https://api.caelario.com", "win32");
  assert.ok(claude.args.includes("user"));
  assert.deepEqual(claude.args.slice(-6), ["cmd", "/c", "npx", "-y", "caelario-mcp", "serve"]);
});

test("rejects unsafe installer inputs", () => {
  assert.throws(() => registrationCommand("cursor", "cae_test_1234567890"), /codex or claude/);
  assert.throws(() => registrationCommand("codex", "bad key; whoami"), /format/);
  assert.throws(() => registrationCommand("codex", "cae_test_1234567890", "http://api.example.com"), /HTTPS/);
});

test("stdio package exposes the complete operational tool set", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/caelario-mcp.js", import.meta.url)), "serve"],
    env: { ...process.env, CAELARIO_API_KEY: "cae_test_1234567890" },
  });
  const client = new Client({ name: "caelario-package-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const expected of ["discover_platforms", "get_operation_guide", "estimate_credits", "extract_now", "create_extraction", "wait_for_extraction", "get_extraction_result", "create_batch", "create_schedule", "manage_schedule"]) {
      assert.ok(names.has(expected), expected);
    }
    assert.equal(names.size, 21);
  } finally {
    await client.close();
  }
});

test("credit estimates match backend profile bundle reservation rules", async () => {
  const api = http.createServer((request, response) => {
    assert.equal(request.headers["x-api-key"], "cae_test_1234567890");
    assert.equal(request.url, "/v1/platforms");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{
      platform: "instagram",
      operations: [
        { operation: "profile", max_results: 1, credits_per_result: 1, results_per_credit: 1, base_credits: 0 },
        { operation: "posts", max_results: 200, credits_per_result: 1, results_per_credit: 2, base_credits: 0 },
      ],
    }]));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const { port } = api.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/caelario-mcp.js", import.meta.url)), "serve"],
    env: {
      ...process.env,
      CAELARIO_API_KEY: "cae_test_1234567890",
      CAELARIO_API_URL: `http://127.0.0.1:${port}`,
    },
  });
  const client = new Client({ name: "caelario-estimate-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "estimate_credits",
      arguments: { platform: "instagram", operation: "profile", limit: 1, include_posts: 6, target_count: 1 },
    });
    assert.equal(result.structuredContent.result.maximum_reserved_credits_per_target, 7);
    assert.equal(result.structuredContent.result.maximum_reserved_credits_total, 7);
  } finally {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  }
});


async function withTestMcp(handler, run, extraEnv = {}) {
  const api = http.createServer(handler);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "caelario-reliability-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/caelario-mcp.js", import.meta.url)), "serve"],
    env: { ...process.env, CAELARIO_API_KEY: "cae_test_1234567890", CAELARIO_API_URL: `http://127.0.0.1:${api.address().port}`, ...extraEnv },
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  }
}

test("uncertain MCP write returns the exact retry key without leaking transport details", async () => {
  let received;
  await withTestMcp((req, res) => {
    received = req.headers["idempotency-key"];
    setTimeout(() => { if (!res.destroyed) res.end("{}"); }, 150);
  }, async (client) => {
    const result = await client.callTool({ name: "extract_now", arguments: {
      platform: "instagram", operation: "profile", target: "test", idempotency_key: "repeat-identical-request",
    } });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.error, "api_transport_error");
    assert.equal(error.idempotency_key, "repeat-identical-request");
    assert.equal(received, error.idempotency_key);
    assert.equal(error.outcome_unknown, true);
    assert.equal(error.retryable, true);
    assert.ok(!result.content[0].text.includes("cae_test_1234567890"));
  }, { CAELARIO_MCP_TIMEOUT_MS: "40" });
});

test("HTTP failure retains job recovery metadata and redacts the API key", async () => {
  await withTestMcp((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: {
      error: "egress_unavailable", job_id: "job-safe", retryable: true,
      message: "unavailable cae_test_1234567890", internal: "must not be exposed",
    } }));
  }, async (client) => {
    const result = await client.callTool({ name: "extract_now", arguments: {
      platform: "facebook", operation: "profile", target: "test", idempotency_key: "same-key",
    } });
    const error = JSON.parse(result.content[0].text);
    assert.equal(result.isError, true);
    assert.equal(error.job_id, "job-safe");
    assert.equal(error.idempotency_key, "same-key");
    assert.equal(error.outcome_unknown, false);
    assert.ok(!result.content[0].text.includes("cae_test_1234567890"));
    assert.ok(!result.content[0].text.includes("must not be exposed"));
  });
});

test("successful HTTP with invalid JSON preserves uncertain-write recovery", async () => {
  await withTestMcp((req, res) => res.end("not-json"), async (client) => {
    const result = await client.callTool({ name: "create_extraction", arguments: {
      platform: "instagram", operation: "profile", target: "test", idempotency_key: "recover-this-request",
    } });
    const error = JSON.parse(result.content[0].text);
    assert.equal(result.isError, true);
    assert.equal(error.error, "invalid_api_response");
    assert.equal(error.idempotency_key, "recover-this-request");
    assert.equal(error.outcome_unknown, true);
  });
});

test("failed result pages retain the reason and never claim readiness", async () => {
  await withTestMcp((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "failed-job", status: "failed", result: null,
      error: { error: "egress_unavailable", retryable: true } }));
  }, async (client) => {
    const result = await client.callTool({ name: "get_extraction_result", arguments: { job_id: "failed-job" } });
    assert.equal(result.structuredContent.result.ready, false);
    assert.equal(result.structuredContent.result.error.error, "egress_unavailable");
  });
});

test("installer rejects shell metacharacters and non-HTTP API origins", () => {
  for (const url of ["https://api.example&example.com", "https://api.example%25.com", "ftp://localhost"]) {
    assert.throws(() => registrationCommand("codex", "cae_test_1234567890", url, "win32"));
  }
});


test("first install opens the guided setup and verifies the key before registration", async () => {
  const steps = [];
  const output = [];
  const secret = "cae_test_1234567890";
  await installClient("codex", {
    apiKey: "", interactive: true, platform: "linux",
    write: (text) => output.push(text),
    openBrowser: () => steps.push("browser"),
    prompt: async () => { steps.push("prompt"); return secret; },
    verifyKey: async (key) => { assert.equal(key, secret); steps.push("verify"); },
    spawn: (command, args) => { assert.equal(command, "codex"); assert.ok(args.includes(`CAELARIO_API_KEY=${secret}`)); steps.push("register"); return { status: 0 }; },
  });
  assert.deepEqual(steps, ["browser", "prompt", "verify", "register"]);
  assert.ok(output.join("").includes(SETUP_URL));
  assert.ok(!output.join("").includes(secret));
});

test("invalid connection key never writes the client configuration", async () => {
  let registered = false;
  await assert.rejects(installClient("claude", {
    apiKey: "cae_test_1234567890", write: () => {},
    verifyKey: async () => { throw new Error("Key was rejected"); },
    spawn: () => { registered = true; return { status: 0 }; },
  }), /Key was rejected/);
  assert.equal(registered, false);
});

test("help and missing-key errors guide unregistered users to setup without spending credits", async () => {
  const help = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/caelario-mcp.js", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.ok(help.stderr.includes(SETUP_URL));
  assert.ok(help.stderr.includes("Create a free account"));
  assert.equal(help.stdout, "");
  let requests = 0;
  await withTestMcp((req, res) => { requests++; res.end("{}"); }, async (client) => {
    const result = await client.callTool({ name: "get_account", arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(SETUP_URL));
    assert.ok(result.content[0].text.includes("never into chat"));
  }, { CAELARIO_API_KEY: "" });
  assert.equal(requests, 0);
});

test("credit estimate respects unavailable operations from the live catalog", async () => {
  await withTestMcp((req, res) => {
    assert.equal(req.method, "GET");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ platform: "tiktok", operations: [{ operation: "search", available: false, unavailable_reason: "Temporarily unavailable" }] }]));
  }, async (client) => {
    const result = await client.callTool({ name: "estimate_credits", arguments: { platform: "tiktok", operation: "search" } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "operation_unavailable");
  });
});


test("installer checks the workspace endpoint and rejects invalid keys or responses", async () => {
  let status = 200;
  let payload = JSON.stringify({ organization_id: "test-workspace" });
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/account");
    assert.equal(req.headers["x-api-key"], "cae_test_1234567890");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await verifyWorkspaceKey("cae_test_1234567890", url);
    for (status of [401, 403]) {
      await assert.rejects(verifyWorkspaceKey("cae_test_1234567890", url), ConnectionKeyRejectedError);
    }
    status = 200; payload = "<html>not the API</html>";
    await assert.rejects(verifyWorkspaceKey("cae_test_1234567890", url), /unexpected response/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});


for (const rejectionStatus of [401, 403]) {
  test(`inherited rejected key (${rejectionStatus}) returns to setup and accepts a replacement`, async () => {
    const oldKey = "cae_test_expired_12345";
    const rejectedKey = "cae_test_rejected_1234";
    const newKey = "cae_test_current_12345";
    const previousKey = process.env.CAELARIO_API_KEY;
    const requests = [];
    const events = [];
    const output = [];
    const answers = [rejectedKey, newKey];
    const api = http.createServer((req, res) => {
      assert.equal(req.url, "/v1/account");
      assert.equal(req.method, "GET");
      const key = req.headers["x-api-key"];
      requests.push(key);
      res.writeHead(key === newKey ? 200 : rejectionStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(key === newKey ? { organization_id: "test-workspace" } : { detail: "Rejected" }));
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    process.env.CAELARIO_API_KEY = oldKey;
    try {
      await installClient("codex", {
        apiUrl: `http://127.0.0.1:${api.address().port}`, interactive: true, platform: "win32",
        write: (text) => output.push(text),
        openBrowser: () => events.push("browser"),
        prompt: async () => { events.push("prompt"); return `  ${answers.shift()}  `; },
        spawn: (command, args) => {
          assert.equal(command, "codex");
          assert.ok(args.includes(`CAELARIO_API_KEY=${newKey}`));
          assert.ok(!args.includes(`CAELARIO_API_KEY=${oldKey}`));
          assert.deepEqual(requests, [oldKey, rejectedKey, newKey]);
          events.push("register");
          return { status: 0 };
        },
      });
      assert.deepEqual(events, ["browser", "prompt", "prompt", "register"]);
      assert.equal(process.env.CAELARIO_API_KEY, oldKey);
      assert.ok(output.join("").includes("CAELARIO_API_KEY in your environment"));
      assert.ok(output.join("").includes(SETUP_URL));
      for (const key of [oldKey, rejectedKey, newKey]) assert.ok(!output.join("").includes(key));
    } finally {
      if (previousKey === undefined) delete process.env.CAELARIO_API_KEY;
      else process.env.CAELARIO_API_KEY = previousKey;
      api.closeAllConnections();
      await new Promise((resolve) => api.close(resolve));
    }
  });
}

test("malformed inherited and pasted keys retry without requests or registration", async () => {
  const newKey = "cae_test_current_12345";
  const answers = ["", "incomplete", newKey];
  const events = [];
  const output = [];
  await installClient("claude", {
    apiKey: "malformed key", interactive: true, platform: "linux",
    write: (text) => output.push(text),
    openBrowser: () => events.push("browser"),
    prompt: async () => { events.push("prompt"); return answers.shift(); },
    verifyKey: async (key) => { assert.equal(key, newKey); events.push("verify"); },
    spawn: () => { events.push("register"); return { status: 0 }; },
  });
  assert.deepEqual(events, ["browser", "prompt", "prompt", "prompt", "verify", "register"]);
  assert.ok(!output.join("").includes(newKey));
});

test("valid inherited key keeps the noninteractive install path", async () => {
  const events = [];
  await installClient("codex", {
    apiKey: "cae_test_current_12345", interactive: false, platform: "linux", write: () => {},
    openBrowser: () => assert.fail("Valid inherited key must not open a browser"),
    prompt: async () => assert.fail("Valid inherited key must not prompt"),
    verifyKey: async () => { events.push("verify"); },
    spawn: () => { events.push("register"); return { status: 0 }; },
  });
  assert.deepEqual(events, ["verify", "register"]);
});

test("rejected key in a noninteractive install fails with setup URL and no prompts", async () => {
  await assert.rejects(installClient("codex", {
    apiKey: "cae_test_expired_12345", interactive: false, write: () => {},
    openBrowser: () => assert.fail("Noninteractive install must not open a browser"),
    prompt: async () => assert.fail("Noninteractive install must not wait for input"),
    verifyKey: async () => { throw new ConnectionKeyRejectedError(); },
    spawn: () => assert.fail("Rejected key must not be registered"),
  }), (error) => error instanceof ConnectionKeyRejectedError && error.message.includes(SETUP_URL));
});

test("noninteractive missing or malformed key never prompts or writes configuration", async () => {
  for (const apiKey of ["", "incomplete"]) {
    await assert.rejects(installClient("codex", {
      apiKey, interactive: false, write: () => {},
      prompt: async () => assert.fail("Noninteractive install must not wait for input"),
      verifyKey: async () => assert.fail("Missing or malformed key must not be sent"),
      spawn: () => assert.fail("Unverified key must not be registered"),
    }), (error) => error.message.includes(SETUP_URL));
  }
});

test("network and server errors do not trigger key replacement or registration", async () => {
  for (const message of ["Could not reach Caelario", "Caelario could not verify the key right now", "Unexpected API response"]) {
    await assert.rejects(installClient("codex", {
      apiKey: "cae_test_current_12345", interactive: true, write: () => {},
      openBrowser: () => assert.fail("Service error must not reopen setup"),
      prompt: async () => assert.fail("Service error must not ask to replace a valid key"),
      verifyKey: async () => { throw new Error(message); },
      spawn: () => assert.fail("Unverified key must not be registered"),
    }), (error) => error.message === message);
  }
});

test("cancelling replacement setup leaves the client configuration untouched", async () => {
  let opened = false;
  await assert.rejects(installClient("claude", {
    apiKey: "cae_test_expired_12345", interactive: true, write: () => {},
    openBrowser: () => { opened = true; },
    prompt: async () => { throw new Error("installation cancelled"); },
    verifyKey: async () => { throw new ConnectionKeyRejectedError(); },
    spawn: () => assert.fail("Cancelled replacement must not write configuration"),
  }), /installation cancelled/);
  assert.equal(opened, true);
});

test("Windows desktop Codex is discovered when no CLI is on PATH", () => {
  const desktop = "C:/Program Files/WindowsApps/OpenAI.Codex_1/app/resources/codex.exe";
  const calls = [];
  const found = resolveClientExecutable("codex", {
    platform: "win32", env: {}, exists: (path) => path === desktop,
    spawn: (command, args, options) => {
      calls.push(command);
      if (command === "where.exe") return { status: 1, stdout: "" };
      if (command.endsWith("powershell.exe")) {
        assert.ok(args.at(-1).includes("Get-AppxPackage -Name OpenAI.Codex"));
        return { status: 0, stdout: `${desktop}\r\n` };
      }
      assert.equal(command, desktop);
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.shell, false);
      return { status: 0 };
    },
  });
  assert.deepEqual(found, { command: desktop, shell: false });
  assert.equal(calls.length, 3);
});

test("Windows CLI shim with spaces is quoted and checked before registration", () => {
  const shim = "C:/Users/Test User/AppData/Roaming/npm/claude.cmd";
  const found = resolveClientExecutable("claude", {
    platform: "win32", exists: () => true,
    spawn: (command, args, options) => {
      if (command === "where.exe") return { status: 0, stdout: `${shim}\r\n` };
      assert.equal(command, `"${shim}"`);
      assert.equal(options.shell, true);
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "2.1.0 (Claude Code)" };
    },
  });
  assert.deepEqual(found, { command: `"${shim}"`, shell: true });
});

test("Unix CLI is resolved directly without Windows discovery", () => {
  const found = resolveClientExecutable("codex", {
    platform: "linux",
    spawn: (command, args, options) => {
      assert.equal(command, "codex");
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.shell, false);
      return { status: 0 };
    },
  });
  assert.deepEqual(found, { command: "codex", shell: false });
});

test("missing assistant fails before opening setup, requesting or checking a key", async () => {
  await assert.rejects(runInstallClient("codex", {
    apiKey: "", interactive: true, write: () => {},
    resolveClient: () => { throw new Error("Codex was not found"); },
    openBrowser: () => assert.fail("No browser before assistant preflight"),
    prompt: async () => assert.fail("No key request before assistant preflight"),
    verifyKey: async () => assert.fail("No API request before assistant preflight"),
    spawn: () => assert.fail("No registration before assistant preflight"),
  }), /Codex was not found/);
});

test("bundled desktop executable registers without a shell and redacts child output", async () => {
  const secret = "cae_test_current_12345";
  const output = [];
  const desktop = "C:/Program Files/WindowsApps/OpenAI.Codex_1/app/resources/codex.exe";
  await installClient("codex", {
    apiKey: secret, interactive: false, platform: "win32", write: (text) => output.push(text),
    resolveClient: () => ({ command: desktop, shell: false }),
    verifyKey: async () => {},
    spawn: (command, args, options) => {
      assert.equal(command, desktop);
      assert.equal(options.shell, false);
      assert.equal(options.stdio, "pipe");
      assert.ok(args.includes(`CAELARIO_API_KEY=${secret}`));
      return { status: 0, stdout: `Registered ${secret}`, stderr: `Notice: ${secret}` };
    },
  });
  assert.ok(!output.join("").includes(secret));
  assert.ok(output.join("").includes("Restart the client"));
});
