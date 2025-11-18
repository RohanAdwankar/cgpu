import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from "../colab/headers.js";
import { AssignedRuntime } from "./runtime-manager.js";

export interface UploadFileOptions {
  runtime: AssignedRuntime;
  localPath: string;
  remotePath?: string;
}

export interface UploadFileResult {
  remotePath: string;
  bytes: number;
}

export async function uploadFileToRuntime(
  options: UploadFileOptions,
): Promise<UploadFileResult> {
  const { runtime, localPath } = options;
  const resolvedLocal = path.resolve(localPath);
  const stats = await fs.stat(resolvedLocal);
  if (!stats.isFile()) {
    throw new Error(`Cannot upload ${resolvedLocal}: not a file.`);
  }
  const fileBuffer = await fs.readFile(resolvedLocal);
  const { relative, display } = resolveRemotePath(
    options.remotePath,
    resolvedLocal,
  );
  const base = new URL(runtime.proxy.url);
  const target = new URL(`api/contents/${encodeContentsPath(relative)}`, base);
  target.searchParams.set("authuser", "0");
  const response = await fetch(target, {
    method: "PUT",
    headers: {
      [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: runtime.proxy.token,
      [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "file",
      format: "base64",
      content: fileBuffer.toString("base64"),
    }),
  });
  if (!response.ok) {
    let responseText: string | undefined;
    try {
      responseText = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `Upload failed (${response.status} ${response.statusText})${responseText ? `: ${responseText}` : ""}`,
    );
  }
  return { remotePath: display, bytes: fileBuffer.length };
}

export function resolveRemotePath(
  remotePath: string | undefined,
  localPath: string,
): { relative: string; display: string } {
  const basename = path.basename(localPath);
  const defaultPath = path.posix.join("content", basename);
  const normalized = normalizePath(remotePath ?? defaultPath);
  return { relative: normalized, display: `/${normalized}` };
}

function normalizePath(rawPath: string): string {
  const replaced = rawPath.replace(/\\/g, "/");
  const trimmed = replaced.replace(/^\/+/, "").replace(/\/+/g, "/");
  const safeSegments = trimmed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "..");
  const normalized = safeSegments.join("/");
  return normalized.length > 0 ? normalized : "content";
}

export function encodeContentsPath(pathValue: string): string {
  return pathValue
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
