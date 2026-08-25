import { randomUUID } from "node:crypto";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const operation = z.string().min(1).max(64).describe("Operation returned by discover_platforms");
const platform = z.string().min(1).max(32).describe("Platform returned by discover_platforms");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

function apiConfiguration() {
  const apiKey = (process.env.CAELARIO_API_KEY || "").trim();
  if (!apiKey) throw new Error("CAELARIO_API_KEY is required; run `npx -y caelario-mcp install codex` or `install claude`");
  const baseUrl = new URL(process.env.CAELARIO_API_URL || "https://api.caelario.com");
  if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname)) {
    throw new Error("CAELARIO_API_URL requires HTTPS except on loopback");
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
    throw new Error("CAELARIO_API_URL must contain only an API origin");
  }
  return { apiKey, baseUrl: baseUrl.origin };
}

async function api(method, path, { body, params, idempotencyKey } = {}) {
  const { apiKey, baseUrl } = apiConfiguration();
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.CAELARIO_MCP_TIMEOUT_MS || 30_000)),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail;
    const code = typeof detail === "object" ? detail?.error : undefined;
    const message = typeof detail === "object" ? detail?.message : typeof detail === "string" ? detail : undefined;
    throw new Error(`Caelario API request failed (${response.status}${code ? `, ${code}` : ""})${message ? `: ${message}` : ""}`);
  }
  return payload;
}

function response(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function withoutResult(job) {
  if (!job || typeof job !== "object") return job;
  const { result: _result, ...summary } = job;
  return summary;
}

function capabilityFor(catalog, platformName, operationName) {
  const definition = catalog.find((item) => item.platform === platformName.toLowerCase());
  const capability = definition?.operations?.find((item) => item.operation === operationName);
  if (!definition || !capability) throw new Error(`Unsupported operation: ${platformName}/${operationName}`);
  return { definition, capability };
}

function billing(capability) {
  if (capability.base_credits && !capability.credits_per_result) {
    return `${capability.base_credits} credits for a non-empty collection; valid empty results cost 0.`;
  }
  if (capability.results_per_credit > 1) {
    return `${capability.credits_per_result} credits per ${capability.results_per_credit} delivered results, rounded up.`;
  }
  return `${capability.credits_per_result} credit${capability.credits_per_result === 1 ? "" : "s"} per delivered result.`;
}

function pagedResult(job, offset, limit, textOffset, textLimit) {
  const page = (value) => Array.isArray(value) ? value.slice(offset, offset + limit) : value;
  let result = job.result;
  const pagination = {};
  if (Array.isArray(result)) {
    pagination.result = pageInfo(result.length, offset, limit);
    result = page(result);
  } else if (result && typeof result === "object") {
    result = { ...result };
    for (const [key, value] of Object.entries(result)) {
      if (Array.isArray(value)) {
        pagination[key] = pageInfo(value.length, offset, limit);
        result[key] = page(value);
      } else if (typeof value === "string" && (textOffset || value.length > textLimit)) {
        pagination[key] = pageInfo(value.length, textOffset, textLimit);
        result[key] = value.slice(textOffset, textOffset + textLimit);
      }
    }
  }
  return { job_id: job.id, status: job.status, ready: job.status === "completed" && job.result != null, result_count: job.result_count, billed_credits: job.billed_credits, source_exhausted: Boolean(job.source_exhausted), next_cursor: job.next_cursor ?? null, result, pagination };
}

function pageInfo(total, offset, limit) {
  const returned = Math.max(0, Math.min(limit, total - offset));
  return { offset, limit, returned, total, next_offset: offset + returned < total ? offset + returned : null };
}

function requestBody(input) {
  return { platform: input.platform, operation: input.operation, target: input.target, limit: input.limit, include_posts: input.include_posts, cursor: input.cursor ?? null };
}

const extractionSchema = z.object({
  platform,
  operation,
  target: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(25_000).default(12),
  include_posts: z.number().int().min(0).max(200).default(0),
  cursor: z.string().max(8_000).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
});

export function createServer() {
  const server = new McpServer(
    { name: "Caelario", version: "0.1.0" },
    { instructions: "Use discover_platforms and get_operation_guide before unfamiliar or expensive work. Prefer extract_now for one bounded target. Use durable jobs or batches for larger work, then wait and page the result. Only a Caelario workspace API key is needed; never ask users for social-network credentials." },
  );
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async (input) => response(await handler(input)));

  tool("discover_platforms", "List every Caelario platform, operation, limit, and price.", z.object({}), () => api("GET", "/v1/platforms"));
  tool("get_operation_guide", "Explain and validate one operation before spending credits.", z.object({ platform, operation }), async (input) => {
    const catalog = await api("GET", "/v1/platforms");
    const { capability } = capabilityFor(catalog, input.platform, input.operation);
    return { platform: input.platform.toLowerCase(), operation: input.operation, capability, billing: billing(capability) };
  });
  tool("get_account", "Return workspace identity and extraction limits.", z.object({}), () => api("GET", "/v1/account"));
  tool("get_credit_usage", "Return available, reserved, promotional, purchased, and spent credits.", z.object({}), () => api("GET", "/v1/usage/current"));
  tool("estimate_credits", "Estimate the maximum reservation for one or many targets before starting work.", z.object({ platform, operation, limit: z.number().int().min(1).max(25_000).default(12), include_posts: z.number().int().min(0).max(200).default(0), target_count: z.number().int().min(1).max(100).default(1) }), async (input) => {
    const catalog = await api("GET", "/v1/platforms");
    const { definition, capability } = capabilityFor(catalog, input.platform, input.operation);
    const single = new Set(["profile", "post", "video", "transcript", "adlibrary_ad", "adlibrary_ad_transcript", "profile_analytics", "playlist"]);
    const fixedCollection = input.platform.toLowerCase() === "instagram" && new Set(["highlights", "highlight_items", "stories"]).has(input.operation);
    const normalizedLimit = single.has(input.operation) ? 1 : fixedCollection ? capability.max_results : input.limit;
    if (normalizedLimit > capability.max_results) throw new Error(`limit exceeds the platform maximum of ${capability.max_results}`);
    if (input.include_posts && input.operation !== "profile") throw new Error("include_posts is supported only for profile requests");
    const posts = input.include_posts ? definition.operations.find((item) => item.operation === "posts") : null;
    if (input.include_posts > (posts?.max_results || 0)) throw new Error(`include_posts exceeds the platform maximum of ${posts?.max_results || 0}`);
    // Profile bundles use the backend's included_credit_rate. Standalone post
    // list grouping does not apply to posts embedded in a profile request.
    const included = input.include_posts * (posts?.credits_per_result || 0);
    const perTarget = capability.base_credits + Math.ceil(normalizedLimit * capability.credits_per_result / Math.max(1, capability.results_per_credit)) + Math.ceil(included);
    return { ...input, normalized_limit: normalizedLimit, maximum_reserved_credits_per_target: perTarget, maximum_reserved_credits_total: perTarget * input.target_count, settlement: "Actual billing uses delivered results and releases unused reservation." };
  });
  tool("extract_now", "Run one bounded target synchronously and return a model-safe result page.", extractionSchema.extend({ result_offset: z.number().int().min(0).default(0), result_limit: z.number().int().min(1).max(100).default(50), text_offset: z.number().int().min(0).default(0), text_limit: z.number().int().min(1).max(50_000).default(20_000) }), async (input) => {
    const idempotencyKey = input.idempotency_key || randomUUID();
    const job = await api("POST", "/v1/extract", { body: requestBody(input), idempotencyKey });
    return { idempotency_key: idempotencyKey, ...pagedResult(job, input.result_offset, input.result_limit, input.text_offset, input.text_limit) };
  });
  tool("create_extraction", "Create one durable extraction job for work that may continue in the background.", extractionSchema, async (input) => {
    const idempotencyKey = input.idempotency_key || randomUUID();
    return { idempotency_key: idempotencyKey, job: withoutResult(await api("POST", "/v1/jobs", { body: requestBody(input), idempotencyKey })) };
  });
  tool("list_extractions", "List recent durable extraction jobs without embedding their large results.", z.object({ limit: z.number().int().min(1).max(100).default(25) }), (input) => api("GET", "/v1/jobs", { params: input }));
  tool("get_extraction", "Get one job's progress, billing, and error metadata.", z.object({ job_id: id }), async ({ job_id }) => withoutResult(await api("GET", `/v1/jobs/${job_id}`)));
  tool("get_extraction_result", "Page through a completed job's structured result without flooding model context.", z.object({ job_id: id, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), text_offset: z.number().int().min(0).default(0), text_limit: z.number().int().min(1).max(50_000).default(20_000) }), async (input) => pagedResult(await api("GET", `/v1/jobs/${input.job_id}`), input.offset, input.limit, input.text_offset, input.text_limit));
  tool("wait_for_extraction", "Wait briefly for a durable job to become terminal without returning its large result.", z.object({ job_id: id, timeout_seconds: z.number().min(1).max(120).default(60), poll_interval_seconds: z.number().min(.5).max(10).default(2) }), async (input) => {
    const deadline = Date.now() + input.timeout_seconds * 1_000;
    while (true) {
      const job = await api("GET", `/v1/jobs/${input.job_id}`);
      if (TERMINAL.has(job.status)) return { timed_out: false, job: withoutResult(job) };
      if (Date.now() >= deadline) return { timed_out: true, job: withoutResult(job) };
      await new Promise((resolve) => setTimeout(resolve, input.poll_interval_seconds * 1_000));
    }
  });
  tool("cancel_extraction", "Cancel a queued job or request cancellation of a running job.", z.object({ job_id: id }), ({ job_id }) => api("POST", `/v1/jobs/${job_id}/cancel`));
  tool("create_batch", "Run one operation for up to 100 targets as an expandable durable batch.", z.object({ platform, operation, targets: z.array(z.string().min(1).max(2_000)).min(1).max(100), limit: z.number().int().min(1).max(25_000).default(12), include_posts: z.number().int().min(0).max(200).default(0), idempotency_key: z.string().min(1).max(128).optional() }), async ({ idempotency_key, ...input }) => {
    const idempotencyKey = idempotency_key || randomUUID();
    return { idempotency_key: idempotencyKey, batch: await api("POST", "/v1/batches", { body: input, idempotencyKey }) };
  });
  tool("list_batches", "List recent batches and optionally their child jobs.", z.object({ limit: z.number().int().min(1).max(100).default(25), include_jobs: z.boolean().default(false) }), (input) => api("GET", "/v1/batches", { params: input }));
  tool("get_batch", "Get aggregate status and child jobs for one batch.", z.object({ batch_id: id }), ({ batch_id }) => api("GET", `/v1/batches/${batch_id}`));
  tool("cancel_batch", "Cancel queued batch children and request cancellation of running children.", z.object({ batch_id: id }), ({ batch_id }) => api("POST", `/v1/batches/${batch_id}/cancel`));
  tool("list_schedules", "List active and paused extraction schedules.", z.object({ limit: z.number().int().min(1).max(100).default(50) }), (input) => api("GET", "/v1/schedules", { params: input }));
  tool("get_schedule", "Get one schedule and its recent run history.", z.object({ schedule_id: id }), ({ schedule_id }) => api("GET", `/v1/schedules/${schedule_id}`));
  const scheduleSchema = z.object({ name: z.string().min(1).max(120), platform, operation, targets: z.array(z.string().min(1).max(2_000)).min(1).max(100), frequency: z.enum(["once", "daily", "weekly", "monthly"]), timezone: z.string().min(1).max(100), starts_at: z.iso.datetime({ offset: true }), limit: z.number().int().min(1).max(25_000).default(12), include_posts: z.number().int().min(0).max(200).default(0) });
  tool("create_schedule", "Create a timezone-aware once, daily, weekly, or monthly extraction schedule.", scheduleSchema, (input) => api("POST", "/v1/schedules", { body: { ...input, overlap_policy: "skip" } }));
  tool("update_schedule", "Replace a schedule definition while preserving its run history.", scheduleSchema.extend({ schedule_id: id }), ({ schedule_id, ...input }) => api("PUT", `/v1/schedules/${schedule_id}`, { body: { ...input, overlap_policy: "skip" } }));
  tool("manage_schedule", "Pause, resume, run now, or delete an extraction schedule.", z.object({ schedule_id: id, action: z.enum(["pause", "resume", "run", "delete"]) }), ({ schedule_id, action }) => action === "delete" ? api("DELETE", `/v1/schedules/${schedule_id}`) : api("POST", `/v1/schedules/${schedule_id}/${action}`));
  return server;
}

export async function runServer() {
  await serveStdio(createServer);
}
