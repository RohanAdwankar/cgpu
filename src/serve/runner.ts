import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError, describeValue } from "./utils.js";

export interface GeminiRunRequest {
  prompt: string;
  model: string;
  geminiBin: string;
  cwdPrefix?: string;
  timeoutMs?: number;
}

export interface GeminiRunResult {
  text: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  raw: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runGeminiCli({
  prompt,
  model,
  geminiBin,
  cwdPrefix,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GeminiRunRequest): Promise<GeminiRunResult> {
  if (!prompt || !prompt.trim()) {
    throw new HttpError(400, "empty_prompt", "Prompt must not be empty");
  }

  const workspaceRoot = await fs.mkdtemp(
    path.join(cwdPrefix ?? os.tmpdir(), "cgpu-serve-"),
  );

  const env = {
    ...process.env,
    SANDBOX: "1",
    GEMINI_CLI_NO_RELAUNCH: "1",
    CI: "1",
    NO_COLOR: "1",
    GEMINI_CLI_DISABLE_UPDATE_CHECK: "1",
  } satisfies NodeJS.ProcessEnv;

  const args = [
    "--output-format",
    "json",
    "--model",
    model,
    prompt,
  ];

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  let completed = false;

  try {
    const child = spawn(geminiBin, args, {
      cwd: workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!completed) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const exitCode: number = await new Promise((resolve, reject) => {
      child.once("error", (err) => reject(err));
      child.once("close", (code) => resolve(code ?? 0));
    });

    completed = true;
    clearTimeout(timer);

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    if (exitCode !== 0) {
      let message = stderr || `Gemini CLI exited with code ${exitCode}`;
      // Remove common noise from stderr
      message = message.replace(/^Loaded cached credentials\.\n?/gm, "").trim();

      throw new HttpError(
        502,
        "gemini_cli_error",
        message,
        stdout,
      );
    }

    if (!stdout) {
      throw new HttpError(502, "empty_response", "Gemini CLI produced no output");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new HttpError(
        502,
        "invalid_json",
        "Gemini CLI returned malformed JSON",
        stdout,
      );
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new HttpError(
        502,
        "invalid_shape",
        `Gemini CLI returned unexpected payload: ${describeValue(parsed)}`,
        parsed,
      );
    }

    if ("error" in parsed && parsed.error) {
      const message = typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as { message?: string }).message
        : undefined;
      throw new HttpError(502, "gemini_cli_failure", message ?? "Gemini CLI reported an error", parsed);
    }

    const text = typeof (parsed as { response?: unknown }).response === "string"
      ? (parsed as { response: string }).response.trim()
      : "";

    const stats = (parsed as { stats?: GeminiRunResult["stats"] }).stats;

    return {
      text,
      stats,
      raw: parsed,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new HttpError(
        500,
        "gemini_cli_missing",
        `Unable to find Gemini CLI executable "${geminiBin}". Install it globally or pass --gemini-bin to cgpu serve.`,
      );
    }
    throw error;
  } finally {
    completed = true;
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

export function createResponseId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
