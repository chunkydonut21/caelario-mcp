#!/usr/bin/env node

import { installClient, printHelp } from "../src/install.js";
import { runServer } from "../src/server.js";

const [command = "serve", client] = process.argv.slice(2);

try {
  if (command === "serve") {
    await runServer();
  } else if (command === "install" && ["codex", "claude", "claude-desktop"].includes(client)) {
    await installClient(client);
  } else if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
  } else {
    printHelp();
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Caelario MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
