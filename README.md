# Caelario MCP

MCP server for social media data from Instagram, TikTok, YouTube, X and
Facebook. Run extractions, search and discovery, batches, schedules, saved
results and usage workflows through Caelario.

Source: <https://github.com/chunkydonut21/caelario-mcp>

The official local server gives Codex and Claude Code typed tools for capability
discovery, immediate and durable extraction, result pagination, and credit
estimates.

## Install for Codex

```bash
npx -y caelario-mcp install codex
```

## Install for Claude Code

```bash
npx -y caelario-mcp install claude
```

The installer prompts for a Caelario workspace API key and registers the stdio
server at user scope. It does not ask for Instagram, TikTok, YouTube, X, or
Facebook credentials; provider identities are managed by Caelario.

After installation, restart the client and ask:

> Use Caelario to get Nike's Instagram profile and 10 recent posts.

The package requires Node.js 20 or newer. See
<https://caelario.com/mcp-server> for security, billing, and tool details.

The connector is released under the MIT License. Caelario's hosted API,
provider implementations, acquisition infrastructure, and managed identities
are separate proprietary services and are not included in this package.

The npm artifact also includes official MCP Registry metadata under
`io.github.chunkydonut21/caelario`. npm publication must happen before the
separate Registry publication step.
