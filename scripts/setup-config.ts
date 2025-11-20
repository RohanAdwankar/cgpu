#!/usr/bin/env tsx
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COLAB_API_DOMAIN,
  DEFAULT_COLAB_GAPI_DOMAIN,
  getDefaultConfigPath,
  runInteractiveOAuthWizard,
  type ConfigFile,
  writeConfigFile,
} from "../src/config.js";

interface ExtensionConfigResult {
  config: ConfigFile;
  source: string;
}

const PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

const EXTENSION_DIRS = dedupe([
  path.join(os.homedir(), ".vscode", "extensions"),
  path.join(os.homedir(), ".vscode-insiders", "extensions"),
  path.join(os.homedir(), "Library", "Application Support", "Code", "extensions"),
  path.join(os.homedir(), "Library", "Application Support", "Code - Insiders", "extensions"),
  path.join(os.homedir(), "AppData", "Roaming", "Code", "extensions"),
  path.join(os.homedir(), "AppData", "Roaming", "Code - Insiders", "extensions"),
]);

const DEFAULT_DOMAINS = {
  colabApiDomain: DEFAULT_COLAB_API_DOMAIN,
  colabGapiDomain: DEFAULT_COLAB_GAPI_DOMAIN,
};

async function main() {
  try {
    const extensionConfig = await tryReadFromVsCodeExtension();
    if (extensionConfig) {
      await writeConfigFile(extensionConfig.config);
      console.log(`✅ Saved credentials to ${getDefaultConfigPath()}`);
      console.log(`Credentials were copied from ${extensionConfig.source}`);
      return;
    }
    console.log("No existing Colab credentials found. Launching the guided setup...\n");
    await runInteractiveOAuthWizard();
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
  const config: ConfigFile = {
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
