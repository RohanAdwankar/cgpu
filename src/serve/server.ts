import http, { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  DEFAULT_GEMINI_MODEL,
  HttpError,
  ensureBoolean,
  ensureOptionalNumber,
  mapModelIdentifier,
  normalizeInputToPrompt,
  normalizeInstructions,
  normalizeToolChoice,
  normalizeTools,
  sanitizeMetadata,
} from "./utils.js";
import { createResponseId, runGeminiCli } from "./runner.js";

export interface ServeServerOptions {
  host?: string;
  port?: number;
  geminiBin?: string;
  defaultModel?: string;
  requestTimeoutMs?: number;
  workspaceDirPrefix?: string;
  maxBodySize?: number;
  logger?: Pick<Console, "log" | "error">;
}

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY = 512 * 1024; // 512 KiB

interface CreateResponseRequestBody {
  input: unknown;
  model?: string;
  instructions?: unknown;
  metadata?: unknown;
  tool_choice?: unknown;
  tools?: unknown;
  parallel_tool_calls?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_output_tokens?: unknown;
  store?: unknown;
  stream?: unknown;
  include?: unknown;
  previous_response_id?: unknown;
  conversation?: unknown;
}

interface NormalizedRequest {
  prompt: string;
  requestedModel: string;
  resolvedModel: string;
  instructions: string | null;
  metadata: Record<string, string>;
  toolChoice: string | Record<string, unknown>;
  tools: unknown[];
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  parallelToolCalls: boolean;
}

interface GeminiStats {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface ServerConfig {
  host: string;
  port: number;
  geminiBin: string;
  defaultModel: string;
  requestTimeoutMs: number;
  workspaceDirPrefix?: string;
  maxBodySize: number;
  logger: Pick<Console, "log" | "error">;
}

export async function startServeServer(options: ServeServerOptions = {}): Promise<Server> {
  const config: ServerConfig = {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    geminiBin: options.geminiBin ?? "gemini",
    defaultModel: options.defaultModel ?? DEFAULT_GEMINI_MODEL,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    workspaceDirPrefix: options.workspaceDirPrefix,
    maxBodySize: options.maxBodySize ?? DEFAULT_MAX_BODY,
    logger: options.logger ?? console,
  };

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config);
    } catch (error) {
      handleUnexpectedError(res, config.logger, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      config.logger.log(
        `cgpu serve listening on http://${config.host}:${config.port} (default model: ${config.defaultModel})`,
      );
      resolve();
    });
  });

  const shutdown = () => {
    server.close(() => {
      config.logger.log("cgpu serve shutdown complete");
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  applyCommonHeaders(res);

  if (!req.url) {
    throw new HttpError(404, "not_found", "Request URL is missing");
  }

  const host = req.headers.host ?? `${config.host}:${config.port}`;
  const url = new URL(req.url, `http://${host}`);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    await handleCreateResponse(req, res, config);
    return;
  }

  throw new HttpError(404, "not_found", `No route for ${req.method ?? ""} ${url.pathname}`);
}

async function handleCreateResponse(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const acceptHeader = req.headers["accept"];
  const wantsEventStream = Array.isArray(acceptHeader)
    ? acceptHeader.some((value) => value.includes("text/event-stream"))
    : typeof acceptHeader === "string" && acceptHeader.includes("text/event-stream");

  const rawBody = await readBody(req, config.maxBodySize);
  const body = parseJson(rawBody) as CreateResponseRequestBody;

  if (wantsEventStream || ensureBoolean(body.stream, "stream", false)) {
    throw new HttpError(
      400,
      "streaming_not_supported",
      "Streaming responses are not supported yet. Please omit the stream flag and Accept: text/event-stream.",
    );
  }

  if (body.include && Array.isArray(body.include) && body.include.length > 0) {
    throw new HttpError(400, "include_not_supported", "The include[] parameter is not supported yet.");
  }

  if (body.conversation) {
    throw new HttpError(400, "conversation_not_supported", "Conversations are not supported yet.");
  }

  if (body.previous_response_id) {
    throw new HttpError(
      400,
      "previous_response_not_supported",
      "previous_response_id is not supported yet.",
    );
  }

  if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    config.logger.log("Received tools in request but tool calling is not implemented; continuing without them.");
  }

  const normalized = normalizeRequest(body, config.defaultModel);

  const responseId = createResponseId("resp");
  const messageId = createResponseId("msg");

  const result = await runGeminiCli({
    prompt: normalized.prompt,
    model: normalized.resolvedModel,
    geminiBin: config.geminiBin,
    cwdPrefix: config.workspaceDirPrefix,
    timeoutMs: config.requestTimeoutMs,
  });

  const payload = buildResponsePayload({
    responseId,
    messageId,
    normalized,
    result,
  });

  writeJson(res, 200, payload);
}

function normalizeRequest(body: CreateResponseRequestBody, defaultModel: string): NormalizedRequest {
  if (body.input === undefined) {
    throw new HttpError(400, "missing_input", 'The "input" field is required.');
  }

  const userContent = normalizeInputToPrompt(body.input);
  if (!userContent) {
    throw new HttpError(400, "empty_input", "Input must contain at least one text segment.");
  }

  const instructions = normalizeInstructions(body.instructions);
  const prompt = instructions ? `${instructions}\n\n${userContent}` : userContent;

  const { requested, resolved } = mapModelIdentifier(body.model, defaultModel || DEFAULT_GEMINI_MODEL);

  const metadata = sanitizeMetadata(body.metadata);
  const toolChoice = normalizeToolChoice(body.tool_choice);
  const tools = normalizeTools(body.tools);

  const temperature = ensureOptionalNumber(body.temperature, "temperature");
  if (temperature !== null && (temperature < 0 || temperature > 2)) {
    throw new HttpError(400, "invalid_temperature", "temperature must be between 0 and 2");
  }

  const topP = ensureOptionalNumber(body.top_p, "top_p");
  if (topP !== null && (topP < 0 || topP > 1)) {
    throw new HttpError(400, "invalid_top_p", "top_p must be between 0 and 1");
  }

  const maxOutputTokens = ensureOptionalNumber(body.max_output_tokens, "max_output_tokens");
  const parallelToolCalls = ensureBoolean(body.parallel_tool_calls, "parallel_tool_calls", true);

  return {
    prompt,
    requestedModel: requested,
    resolvedModel: resolved,
    instructions,
    metadata,
    toolChoice,
    tools,
    temperature,
    topP,
    maxOutputTokens,
    parallelToolCalls,
  };
}

function buildResponsePayload({
  responseId,
  messageId,
  normalized,
  result,
}: {
  responseId: string;
  messageId: string;
  normalized: NormalizedRequest;
  result: { text: string; stats?: GeminiStats | undefined };
}) {
  const created = Math.floor(Date.now() / 1000);
  const textContent = result.text || "";
  const stats = result.stats ?? {};
  const inputTokens = stats.input_tokens ?? 0;
  const outputTokens = stats.output_tokens ?? (stats.total_tokens ? Math.max(stats.total_tokens - inputTokens, 0) : 0);
  const totalTokens = stats.total_tokens ?? inputTokens + outputTokens;

  return {
    id: responseId,
    object: "response",
    created_at: created,
    model: normalized.requestedModel,
    status: "completed" as const,
    previous_response_id: null,
    instructions: normalized.instructions,
    error: null,
    incomplete_details: null,
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: textContent,
            annotations: [],
            logprobs: [],
          },
        ],
        status: "completed",
      },
    ],
    output_text: textContent,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: totalTokens,
    },
    metadata: normalized.metadata,
    tool_choice: normalized.toolChoice,
    tools: normalized.tools,
    parallel_tool_calls: normalized.parallelToolCalls,
    temperature: normalized.temperature,
    top_p: normalized.topP,
    max_output_tokens: normalized.maxOutputTokens,
    max_tool_calls: null,
    reasoning: null,
    background: false,
    truncation: "disabled",
  };
}

function applyCommonHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const contentType = req.headers["content-type"];
  const hasJsonContent = Array.isArray(contentType)
    ? contentType.some((value) => value.includes("application/json"))
    : typeof contentType === "string" && contentType.includes("application/json");

  if (!hasJsonContent) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  let size = 0;
  const chunks: Uint8Array[] = [];

  return await new Promise<string>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new HttpError(413, "payload_too_large", "Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJson(body: string): unknown {
  if (!body) {
    throw new HttpError(400, "empty_body", "Request body is empty");
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON", error);
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function handleUnexpectedError(
  res: ServerResponse,
  logger: Pick<Console, "log" | "error">,
  error: unknown,
) {
  if (res.headersSent) {
    logger.error("An error occurred after headers were sent", error);
    res.end();
    return;
  }

  if (error instanceof HttpError) {
    writeJson(res, error.statusCode, {
      error: {
        code: error.errorCode,
        message: error.message,
        details: error.details ?? null,
      },
    });
    return;
  }

  logger.error("Unexpected error while handling request", error);
  writeJson(res, 500, {
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
    },
  });
}
