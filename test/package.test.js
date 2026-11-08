import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { registrationCommand } from "../src/install.js";

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
    description: "A revocable Caelario workspace API key from the Developers page.",
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
