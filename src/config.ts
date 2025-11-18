import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { z, ZodError } from "zod";

const ConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  colabApiDomain: z.string().url(),
  colabGapiDomain: z.string().url(),
  storageDir: z.string().optional(),
});

export type CliConfig = z.infer<typeof ConfigSchema> & {
  storageDir: string;
};

export async function loadConfig(customPath?: string): Promise<CliConfig> {
  loadEnvFiles();
  const searchOrder = [
    customPath,
    path.join(process.cwd(), "cgpu.config.json"),
    path.join(process.cwd(), "colab-cli.config.json"),
    path.join(os.homedir(), ".config", "cgpu", "config.json"),
    path.join(os.homedir(), ".config", "colab-cli", "config.json"),
  ].filter(Boolean) as string[];

  let parsed: z.infer<typeof ConfigSchema> | undefined;
  for (const candidate of searchOrder) {
    try {
      const raw = await fs.readFile(candidate, "utf-8");
      parsed = ConfigSchema.parse(JSON.parse(raw));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      if (err instanceof ZodError) {
        throw new Error(buildFriendlyError(err));
      }
      throw new Error(
        `Failed to read config at ${candidate}: ${(err as Error).message}`,
      );
    }
  }

  if (!parsed) {
    const envConfig = {
      clientId: process.env.COLAB_CLIENT_ID ?? "",
      clientSecret: process.env.COLAB_CLIENT_SECRET ?? "",
      colabApiDomain:
        process.env.COLAB_API_DOMAIN ?? "https://colab.research.google.com",
      colabGapiDomain:
        process.env.COLAB_GAPI_DOMAIN ?? "https://colab.googleapis.com",
      storageDir: process.env.COLAB_STATE_DIR,
    } satisfies Partial<CliConfig>;
    try {
      parsed = ConfigSchema.parse(envConfig);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new Error(buildFriendlyError(err));
      }
      throw err;
    }
  }

  const storageDir = await resolveStorageDir(parsed.storageDir);
  await fs.mkdir(storageDir, { recursive: true });
  return { ...parsed, storageDir };
}

function loadEnvFiles(): void {
  const defaultEnv = path.join(process.cwd(), ".env");
  const userEnvNew = path.join(os.homedir(), ".config", "cgpu", ".env");
  const userEnvLegacy = path.join(os.homedir(), ".config", "colab-cli", ".env");
  for (const candidate of [defaultEnv, userEnvNew, userEnvLegacy]) {
    dotenv.config({ path: candidate, override: false });
  }
}

function buildFriendlyError(err: ZodError): string {
  const issues = err.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  return [
    "Missing Colab OAuth credentials.",
    "Provide COLAB_CLIENT_ID and COLAB_CLIENT_SECRET via:",
    "  • Environment variables (e.g. in a .env file)",
    "  • or cgpu.config.json / ~/.config/cgpu/config.json (legacy colab-cli.* files are still supported)",
    `Validation errors: ${issues}`,
  ].join("\n");
}

async function resolveStorageDir(preferred?: string): Promise<string> {
  if (preferred) {
    return preferred;
  }
  const candidates = [
    path.join(os.homedir(), ".config", "cgpu"),
    path.join(os.homedir(), ".config", "colab-cli"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
