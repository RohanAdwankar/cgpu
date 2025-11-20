import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import envPaths from "env-paths";
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

export type ConfigFile = z.infer<typeof ConfigSchema>;

const appPaths = envPaths("cgpu", { suffix: "" });
const DEFAULT_CONFIG_DIR = process.env.CGPU_CONFIG_DIR
  ? path.resolve(process.env.CGPU_CONFIG_DIR)
  : appPaths.config;
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "config.json");
const DEFAULT_STORAGE_DIR = path.join(DEFAULT_CONFIG_DIR, "state");

export const DEFAULT_COLAB_API_DOMAIN = "https://colab.research.google.com";
export const DEFAULT_COLAB_GAPI_DOMAIN = "https://colab.googleapis.com";

class MissingConfigError extends Error {
  constructor(message: string, readonly issues?: string[]) {
    super(message);
  }
}

export async function loadConfig(customPath?: string): Promise<CliConfig> {
  const configPath = customPath ? path.resolve(customPath) : DEFAULT_CONFIG_PATH;

  while (true) {
    try {
      const parsed = await readConfig(configPath);
      const storageDir = await resolveStorageDir(parsed.storageDir);
      return { ...parsed, storageDir };
    } catch (err) {
      if (err instanceof MissingConfigError) {
        if (!isInteractiveTerminal()) {
          throw new Error(buildMissingCredentialsMessage(configPath, err.issues));
        }
        await runInteractiveOAuthWizard(configPath);
        continue;
      }
      throw err;
    }
  }
}

export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

async function resolveStorageDir(preferred?: string): Promise<string> {
  if (preferred) {
    const resolved = path.resolve(preferred);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }
  await fs.mkdir(DEFAULT_STORAGE_DIR, { recursive: true });
  return DEFAULT_STORAGE_DIR;
}

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function buildMissingCredentialsMessage(
  configPath: string,
  issues?: string[],
): string {
  const lines = [
    "Missing Colab OAuth credentials.",
    `cgpu now stores credentials in a single config file at ${configPath}.`,
    "Re-run this command from an interactive terminal to launch the guided setup,",
    "or create the file manually with your OAuth client ID and secret.",
  ];
  if (issues?.length) {
    lines.push(`Validation errors: ${issues.join("; ")}`);
  }
  return lines.join("\n");
}

async function readConfig(configPath: string): Promise<ConfigFile> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingConfigError("Config file not found");
    }
    if (err instanceof SyntaxError) {
      throw new MissingConfigError("Config file is not valid JSON");
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
      throw new MissingConfigError("Config file is missing required fields", issues);
    }
    throw err;
  }
}

export async function writeConfigFile(
  config: ConfigFile,
  targetPath = DEFAULT_CONFIG_PATH,
): Promise<void> {
  const parsed = ConfigSchema.parse(config);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}

export async function runInteractiveOAuthWizard(
  targetPath = DEFAULT_CONFIG_PATH,
): Promise<void> {
  if (!isInteractiveTerminal()) {
    throw new Error("Interactive setup requires a TTY");
  }

  console.log();
  console.log(
    chalk.bold.cyan(
      "Let's set up your Colab OAuth credentials. This only takes a minute.",
    ),
  );
  const rl = readline.createInterface({ input, output });
  const totalSteps = 4;
  try {
    await guideStep(
      rl,
      1,
      totalSteps,
      "Create a Google Cloud project",
      [
        `Open ${chalk.underline("https://console.cloud.google.com/")} in your browser.`,
        "Click the project selector at the top and choose \"New Project\".",
        "Give it any name (\"cgpu\" works great) and click Create.",
      ],
    );

    await guideStep(
      rl,
      2,
      totalSteps,
      "Create a Desktop OAuth client",
      [
        `Visit ${chalk.underline("https://console.cloud.google.com/auth/clients")}.`,
        "Pick your new project, hit \"Create client\" or \"Get started\".",
        "If you clicked Get Started, Choose any App Name (eg. cgpu), select your email for support email, choose external for the audience, put in your email, then finish.",
        "If you clicked Create client or have finished the previous step, after clicking \"Create client\", select \"Desktop app\" as the application type, give it any name you like (eg. cgpu), and click Create.",
        "After it's created, keep the dialog open—you'll need the generated ID and secret.",
      ],
    );

    await guideStep(
      rl,
      3,
      totalSteps,
      "Add yourself as a test user",
      [
        `Visit ${chalk.underline("https://console.cloud.google.com/auth/audience")}.`,
        `With your project selected click \"Add users\" under the Test Users section.`,
        "Add your Google account email and save.",
      ],
    );



  const credentials = await collectClientCredentials(rl, 4, totalSteps);
    await writeConfigFile({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      colabApiDomain: DEFAULT_COLAB_API_DOMAIN,
      colabGapiDomain: DEFAULT_COLAB_GAPI_DOMAIN,
    }, targetPath);
    console.log(
      chalk.green(
        `${buildProgressBar(totalSteps, totalSteps)} All set! Saved credentials to ${targetPath}.`,
      ),
    );
  } finally {
    rl.close();
  }
}

async function guideStep(
  rl: ReadlineInterface,
  index: number,
  total: number,
  title: string,
  details: string[],
): Promise<void> {
  console.log();
  console.log(
    chalk.cyan(
      `${buildProgressBar(index - 1, total)} Step ${index} of ${total} — ${title}`,
    ),
  );
  details.forEach((line) => console.log(`  • ${line}`));
  await rl.question(chalk.gray("Press Enter once you're done with this step."));
}

async function collectClientCredentials(
  rl: ReadlineInterface,
  index: number,
  totalSteps: number,
): Promise<{ clientId: string; clientSecret: string }> {
  console.log();
  console.log(
    chalk.cyan(
      `${buildProgressBar(index - 1, totalSteps)} Step ${index} of ${totalSteps} — Paste your credentials`,
    ),
  );
  console.log("Paste the values that Google just showed you:");
  const clientId = await askUntilNonEmpty(rl, "Client ID: ");
  const clientSecret = await askUntilNonEmpty(rl, "Client secret: ");
  return { clientId, clientSecret };
}

async function askUntilNonEmpty(rl: ReadlineInterface, prompt: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (answer) {
      return answer;
    }
    console.log(chalk.red("This field is required."));
  }
}

function buildProgressBar(completedSteps: number, totalSteps: number): string {
  const width = 20;
  const ratio = completedSteps / totalSteps;
  const filled = Math.round(ratio * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `[${bar}]`;
}
