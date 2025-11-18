#!/usr/bin/env tsx
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

interface CliConfig {
  clientId: string;
  clientSecret: string;
  colabApiDomain: string;
  colabGapiDomain: string;
}

interface ExtensionConfigResult {
  config: CliConfig;
  source: string;
}

const PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, "cgpu.config.json");
const LEGACY_LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, "colab-cli.config.json");
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "cgpu", "config.json");
const LEGACY_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "colab-cli", "config.json");

const EXTENSION_DIRS = dedupe([
  path.join(os.homedir(), ".vscode", "extensions"),
  path.join(os.homedir(), ".vscode-insiders", "extensions"),
  path.join(os.homedir(), "Library", "Application Support", "Code", "extensions"),
  path.join(os.homedir(), "Library", "Application Support", "Code - Insiders", "extensions"),
  path.join(os.homedir(), "AppData", "Roaming", "Code", "extensions"),
  path.join(os.homedir(), "AppData", "Roaming", "Code - Insiders", "extensions"),
]);

const DEFAULT_DOMAINS = {
  colabApiDomain: "https://colab.research.google.com",
  colabGapiDomain: "https://colab.googleapis.com",
};

async function main() {
  try {
    const extensionConfig = await tryReadFromVsCodeExtension();
    const config = extensionConfig?.config ?? (await promptForConfig());
    await writeConfig(config, extensionConfig?.source);
  } catch (err) {
    console.error("Failed to set up configuration:");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

async function tryReadFromVsCodeExtension(): Promise<ExtensionConfigResult | undefined> {
  const require = createRequire(import.meta.url);
  for (const root of EXTENSION_DIRS) {
    if (!(await pathExists(root))) {
      continue;
    }
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!entry.name.startsWith("googlecolab.colab-vscode")) {
        continue;
      }
      const extensionPath = path.join(root, entry.name);
      const configPath = path.join(extensionPath, "out", "colab-config.js");
      if (!(await pathExists(configPath))) {
        continue;
      }
      try {
        const mod = require(configPath);
        const rawConfig = mod.CONFIG ?? mod.default ?? mod;
        if (!rawConfig?.ClientId || !rawConfig?.ClientNotSoSecret) {
          continue;
        }
        const config: CliConfig = {
          clientId: rawConfig.ClientId,
          clientSecret: rawConfig.ClientNotSoSecret,
          colabApiDomain: rawConfig.ColabApiDomain ?? DEFAULT_DOMAINS.colabApiDomain,
          colabGapiDomain: rawConfig.ColabGapiDomain ?? DEFAULT_DOMAINS.colabGapiDomain,
        };
        console.log(`✅ Found Colab VS Code extension at ${extensionPath}`);
        return { config, source: extensionPath };
      } catch (err) {
        console.warn(`Unable to import config from ${configPath}:`, err);
      }
    }
  }
  console.log("ℹ️ Could not find a local installation of googlecolab.colab-vscode.");
  return undefined;
}

async function promptForConfig(): Promise<CliConfig> {
  console.log("Please enter your Google OAuth credentials.");
  console.log("You can copy these from the VS Code extension or use your own OAuth client.");
  const rl = readline.createInterface({ input, output });
  const clientId = (await rl.question("Client ID: ")).trim();
  const clientSecret = (await rl.question("Client secret: ")).trim();
  const colabApiDomain = (
    await rl.question(`Colab API domain [${DEFAULT_DOMAINS.colabApiDomain}]: `)
  ).trim() || DEFAULT_DOMAINS.colabApiDomain;
  const colabGapiDomain = (
    await rl.question(`Colab GAPI domain [${DEFAULT_DOMAINS.colabGapiDomain}]: `)
  ).trim() || DEFAULT_DOMAINS.colabGapiDomain;
  rl.close();
  if (!clientId || !clientSecret) {
    throw new Error("Client ID and secret are required.");
  }
  return { clientId, clientSecret, colabApiDomain, colabGapiDomain };
}

async function writeConfig(config: CliConfig, source?: string): Promise<void> {
  await fs.writeFile(
    LOCAL_CONFIG_PATH,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
  await fs.mkdir(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  await fs.writeFile(
    GLOBAL_CONFIG_PATH,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
  console.log(`✅ Wrote ${LOCAL_CONFIG_PATH}`);
  console.log(`✅ Wrote ${GLOBAL_CONFIG_PATH}`);
  await syncLegacyConfig(config);
  if (source) {
    console.log(`Credentials were copied from ${source}`);
  }
}

async function syncLegacyConfig(config: CliConfig): Promise<void> {
  const targets = [
    LEGACY_LOCAL_CONFIG_PATH,
    LEGACY_GLOBAL_CONFIG_PATH,
  ];
  for (const target of targets) {
    if (!(await pathExists(target))) {
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf-8");
    console.log(`ℹ️ Updated legacy config at ${target}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

await main();
