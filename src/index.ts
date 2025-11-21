#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "./config.js";
import { FileAuthStorage } from "./auth/session-storage.js";
import { GoogleOAuthManager } from "./auth/oauth-manager.js";
import { ColabClient } from "./colab/client.js";
import { RuntimeManager } from "./runtime/runtime-manager.js";
import { TerminalSession } from "./runtime/terminal-session.js";
import { RemoteCommandRunner } from "./runtime/remote-command-runner.js";
import { buildPosixCommand } from "./utils/shell.js";
import { Variant } from "./colab/api.js";
import { uploadFileToRuntime } from "./runtime/file-transfer.js";
import { startServeServer } from "./serve/server.js";

interface GlobalOptions {
  config?: string;
  forceLogin?: boolean;
}

interface ConnectCommandOptions extends GlobalOptions {
  newRuntime?: boolean;
  startupCommand?: string;
  tpu?: boolean;
  cpu?: boolean;
}

interface RunCommandOptions extends GlobalOptions {
  newRuntime?: boolean;
  verbose?: boolean;
  tpu?: boolean;
  cpu?: boolean;
}

interface CopyCommandOptions extends GlobalOptions {
  newRuntime?: boolean;
  tpu?: boolean;
  cpu?: boolean;
}

async function createApp(configPath?: string) {
  const config = await loadConfig(configPath);
  const storage = new FileAuthStorage(config.storageDir);
  const oauthClient = new OAuth2Client(config.clientId, config.clientSecret);
  const auth = new GoogleOAuthManager(oauthClient, storage);
  const colabClient = new ColabClient(
    new URL(config.colabApiDomain),
    new URL(config.colabGapiDomain),
    async () => (await auth.getAccessToken()).accessToken,
  );
  return { auth, colabClient, config };
}

const program = new Command();
program
  .name("cgpu")
  .description("Cloud GPU CLI")
  .option("-c, --config <path>", "path to config file")
  .option("--force-login", "ignore cached session");

program
  .command("connect")
  .description("Authenticate and open a terminal on a Colab GPU runtime")
  .option(
    "--new-runtime",
    "Request a brand-new Colab runtime instead of reusing an existing one",
  )
  .option(
    "--startup-command <command>",
    "Custom command to run after the remote terminal attaches",
  )
  .option("--tpu", "Request a Colab TPU runtime instead of a GPU")
  .option("--cpu", "Request a CPU-only Colab runtime instead of a GPU")
  .action(async (_args, cmd) => {
    const globalOptions = (cmd.parent?.opts() as GlobalOptions) ?? {};
    const connectOptions = (cmd.opts() as ConnectCommandOptions) ?? {};
    await withApp(globalOptions, async ({ auth, colabClient }) => {
      const session = await auth.getAccessToken(globalOptions.forceLogin);
      console.log(
        chalk.green(
          `Authenticated as ${session.account.label} <${session.account.id}>`,
        ),
      );
      const runtimeManager = new RuntimeManager(colabClient);
      const runtime = await runtimeManager.assignRuntime({
        forceNew: Boolean(connectOptions.newRuntime),
        variant: resolveVariant(connectOptions),
      });
      const terminal = new TerminalSession(colabClient, runtime, {
        startupCommand: connectOptions.startupCommand,
      });
      await terminal.start();
    });
  });

program
  .command("run")
  .description("Run a command on a Colab runtime and stream the output")
  .allowUnknownOption()
  .argument("<command...>", "Command to run remotely")
  .option(
    "--new-runtime",
    "Request a brand-new Colab runtime instead of reusing an existing one",
  )
  .option("--tpu", "Request a Colab TPU runtime instead of a GPU")
  .option("--cpu", "Request a Colab CPU runtime instead of a GPU")
  .option("-v, --verbose", "Show detailed logging during the remote run")
  .action(async (commandArgs: string[], options: RunCommandOptions, cmd) => {
    if (commandArgs.length === 0) {
      throw new Error("No command provided. Pass the command after 'run'.");
    }
    const commandString = buildPosixCommand(commandArgs, {
      quoteFirstArg: false,
    });
    const globalOptions = (cmd.parent?.opts() as GlobalOptions) ?? {};
    const runOptions = options ?? {};
    await withApp(globalOptions, async ({ auth, colabClient }) => {
      const session = await auth.getAccessToken(globalOptions.forceLogin);
      console.log(
        chalk.green(
          `Authenticated as ${session.account.label} <${session.account.id}>`,
        ),
      );
      const runtimeManager = new RuntimeManager(colabClient);
      const runtime = await runtimeManager.assignRuntime({
        forceNew: Boolean(runOptions.newRuntime),
        variant: resolveVariant(runOptions),
        quiet: !runOptions.verbose,
      });
      const runner = new RemoteCommandRunner(colabClient, runtime, {
        verbose: Boolean(runOptions.verbose),
      });
      const exitCode = await runner.run(commandString);
      process.exitCode = exitCode;
    });
  });

program
  .command("copy")
  .description("Upload a local file to your Colab runtime")
  .argument("<source>", "Local file to copy")
  .argument(
    "[destination]",
    "Remote path (defaults to /content/<filename>)",
  )
  .option(
    "--new-runtime",
    "Request a brand-new Colab runtime instead of reusing an existing one",
  )
  .option("--tpu", "Request a Colab TPU runtime instead of a GPU")
  .option("--cpu", "Request a Colab CPU runtime instead of a GPU")
  .action(async (
    source: string,
    destination: string | undefined,
    options: CopyCommandOptions,
    cmd,
  ) => {
    const globalOptions = (cmd.parent?.opts() as GlobalOptions) ?? {};
    const copyOptions = options ?? {};
    await withApp(globalOptions, async ({ auth, colabClient }) => {
      const session = await auth.getAccessToken(globalOptions.forceLogin);
      console.log(
        chalk.green(
          `Authenticated as ${session.account.label} <${session.account.id}>`,
        ),
      );
      const runtimeManager = new RuntimeManager(colabClient);
      const runtime = await runtimeManager.assignRuntime({
        forceNew: Boolean(copyOptions.newRuntime),
        variant: resolveVariant(copyOptions),
        quiet: true,
      });
      const result = await uploadFileToRuntime({
        runtime,
        localPath: source,
        remotePath: destination,
      });
      console.log(
        `${chalk.green("Uploaded")}: ${path.basename(source)} → ${result.remotePath} (${formatBytes(result.bytes)})`,
      );
    });
  });

program
  .command("status")
  .description("Check whether the current session can reach Colab APIs")
  .action(async (_args, cmd) => {
    const options = (cmd.parent?.opts() as GlobalOptions) ?? {};
    await withApp(options, async ({ auth, colabClient }) => {
      const session = await auth.getAccessToken(options.forceLogin);
      const ccu = await colabClient.getCcuInfo();
      console.log(
        `${chalk.green("Authenticated")} as ${session.account.label}. Eligible GPUs: ${ccu.eligibleGpus.join(", ")}`,
      );
    });
  });

program
  .command("logout")
  .description("Forget cached credentials")
  .action(async (_args, cmd) => {
    const options = (cmd.parent?.opts() as GlobalOptions) ?? {};
    await withApp(options, async ({ auth }) => {
      await auth.signOut();
      console.log(chalk.yellow("Signed out and cleared session cache."));
    });
  });

program
  .command("serve")
  .description("Start an OpenAI-compatible API server backed by Google Gemini")
  .option("-p, --port <number>", "Port to listen on", "8080")
  .option("-H, --host <string>", "Host to listen on", "127.0.0.1")
  .option("--gemini-bin <path>", "Path to the gemini executable", "gemini")
  .option("--default-model <model>", "Default model to use if not specified", "gpt-4.1")
  .option("--timeout <ms>", "Request timeout in milliseconds", "120000")
  .option("--workspace-dir <path>", "Directory prefix for temporary workspaces")
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const timeout = parseInt(options.timeout, 10);

    await startServeServer({
      port,
      host: options.host,
      geminiBin: options.geminiBin,
      defaultModel: options.defaultModel,
      requestTimeoutMs: timeout,
      workspaceDirPrefix: options.workspaceDir,
      logger: console,
    });
  });

program.parseAsync().catch((err) => {
  if (isAlreadyReportedError(err)) {
    process.exit(1);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(message));
  if (process.env.CGPU_DEBUG && err instanceof Error && err.stack) {
    console.error(chalk.gray(err.stack));
  }
  process.exit(1);
});

async function withApp(
  options: GlobalOptions,
  fn: (deps: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
) {
  const deps = await createApp(options.config);
  await fn(deps);
}

function resolveVariant({ tpu, cpu }: { tpu?: boolean; cpu?: boolean }): Variant {
  if (tpu && cpu) {
    throw new Error("Choose either --cpu or --tpu, not both.");
  }
  if (tpu) {
    return Variant.TPU;
  }
  if (cpu) {
    return Variant.DEFAULT;
  }
  return Variant.GPU;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function isAlreadyReportedError(err: unknown): err is { alreadyReported: true } {
  return Boolean(
    err && typeof err === "object" && (err as { alreadyReported?: boolean }).alreadyReported,
  );
}
