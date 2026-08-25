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
