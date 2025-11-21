import { inspect } from "node:util";

export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export const KNOWN_GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-thinking-exp",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-1.0-pro",
];

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function mapModelIdentifier(
  requestedModel: string | undefined,
  defaultModel: string = DEFAULT_GEMINI_MODEL,
): { requested: string; resolved: string; mappedFrom: string | null } {
  const fallback = defaultModel.trim();
  const requested = (requestedModel ?? "").trim() || fallback;
  
  return { requested, resolved: requested, mappedFrom: null };
}

export function normalizeInputToPrompt(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (Array.isArray(input)) {
    const segments = input
      .map((item) => formatInputItem(item))
      .filter((segment): segment is string => Boolean(segment && segment.trim()));
    return segments.join("\n\n").trim();
  }
  if (isPlainObject(input)) {
    const single = formatInputItem(input);
    return single?.trim() ?? "";
  }
  throw new HttpError(
    400,
    "invalid_input",
    'The "input" field must be a string or an array of input items.',
  );
}

export function normalizeInstructions(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    const normalized = normalizeInputToPrompt(value);
    return normalized.length > 0 ? normalized : null;
  }
  throw new HttpError(
    400,
    "invalid_instructions",
    'The "instructions" field must be a string or an array of input items.',
  );
}

export function sanitizeMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new HttpError(400, "invalid_metadata", "metadata must be an object of string values");
  }
  const entries: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new HttpError(
        400,
        "invalid_metadata",
        `metadata[${key}] must be a string, received ${typeof raw}`,
      );
    }
    entries[key] = raw;
  }
  return entries;
}

export function normalizeToolChoice(value: unknown): string | Record<string, unknown> {
  if (value === undefined || value === null) {
    return "auto";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isPlainObject(value)) {
    return value;
  }
  throw new HttpError(400, "invalid_tool_choice", "tool_choice must be a string or object");
}

export function normalizeTools(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_tools", "tools must be an array");
  }
  return value;
}

export function ensureBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_boolean", `${field} must be a boolean`);
  }
  return value;
}

export function ensureOptionalNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new HttpError(400, "invalid_number", `${field} must be a number`);
  }
  return value;
}

export function formatRoleLabel(role: string | undefined): string | undefined {
  if (!role) {
    return undefined;
  }
  const trimmed = role.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function formatInputItem(item: unknown): string | null {
  if (typeof item === "string") {
    return item.trim() || null;
  }
  if (!isPlainObject(item)) {
    return null;
  }
  const text = extractTextPayload(item);
  if (!text) {
    return null;
  }
  const role = formatRoleLabel(asMaybeString(item.role));
  return role ? `${role}:\n${text}` : text;
}

function extractTextPayload(value: Record<string, unknown>): string | null {
  if (typeof value.text === "string") {
    return value.text.trim() || null;
  }
  if (typeof value.content === "string") {
    return value.content.trim() || null;
  }
  if (Array.isArray(value.content)) {
    const combined = value.content
      .map((part) => extractTextFromContent(part))
      .filter((segment): segment is string => Boolean(segment && segment.trim()))
      .join("\n")
      .trim();
    if (combined) {
      return combined;
    }
  }
  if (Array.isArray((value as { parts?: unknown[] }).parts)) {
    const combined = (value as { parts: unknown[] }).parts
      .map((part) => extractTextFromContent(part))
      .filter((segment): segment is string => Boolean(segment && segment.trim()))
      .join("\n")
      .trim();
    if (combined) {
      return combined;
    }
  }
  if (typeof value.message === "string") {
    return value.message.trim() || null;
  }
  return null;
}

function extractTextFromContent(part: unknown): string | null {
  if (typeof part === "string") {
    return part.trim() || null;
  }
  if (!isPlainObject(part)) {
    return null;
  }
  if (typeof part.text === "string") {
    return part.text.trim() || null;
  }
  if (typeof part.refusal === "string") {
    return part.refusal.trim() || null;
  }
  if (typeof part.data === "string") {
    return part.data.trim() || null;
  }
  return null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asMaybeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  return inspect(value, { depth: 2, maxArrayLength: 5 });
}
