import { randomUUID } from "crypto";
import chalk from "chalk";
import fetch from "node-fetch";
import WebSocket from "ws";
import { AssignedRuntime } from "./runtime-manager.js";
import { ColabClient } from "../colab/client.js";
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from "../colab/headers.js";

const EXIT_SENTINEL_PREFIX = "__COLAB_CLI_EXIT__";
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const PROMPT_PREFIX = "/# ";

type TerminalFrame =
  | ["stdout", string]
  | ["stderr", string]
  | ["disconnect", string]
  | ["stdin", string]
  | ["set_size", number, number, number, number];

export class RemoteCommandRunner {
  constructor(
    private readonly client: ColabClient,
    private readonly runtime: AssignedRuntime,
    private readonly options: RemoteCommandRunnerOptions = {},
  ) {}

  async run(command: string): Promise<number> {
    if (!command.trim()) {
      throw new Error("Cannot run an empty command");
    }
    if (this.options.verbose) {
      console.log(
        chalk.gray(
          `Running remote command on ${this.runtime.label}: ${command}`,
        ),
      );
    }
    const terminalName = await this.createRemoteTerminal();
    return this.executeInTerminal(terminalName, command);
  }

  private async createRemoteTerminal(): Promise<string> {
    const base = new URL(this.runtime.proxy.url);
    const url = new URL("api/terminals", base);
    const headers: Record<string, string> = {
      [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: this.runtime.proxy.token,
      [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
      "Content-Type": "application/json",
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Failed to create remote terminal: ${res.statusText}`);
    }
    const json = (await res.json()) as { name: string };
    return json.name;
  }

  private async executeInTerminal(
    name: string,
    command: string,
  ): Promise<number> {
    const base = new URL(this.runtime.proxy.url);
    const wsUrl = new URL(`terminals/websocket/${name}`, base);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("authuser", "0");

    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: this.runtime.proxy.token,
        [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
        Origin: base.origin,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });

    const exitMarker = `${EXIT_SENTINEL_PREFIX}${randomUUID()}`;
    const exitCode = await this.streamCommand(ws, command, exitMarker);
    return exitCode;
  }

  private streamCommand(
    ws: WebSocket,
    command: string,
    exitMarker: string,
  ): Promise<number> {
    let stdoutBuffer = "";
    let capturedExitCode: number | undefined;

    const flushLine = (line: string) => {
      const normalized = stripAnsi(line.replace(/\r/g, ""));
      const withoutPrompt = normalized.startsWith(PROMPT_PREFIX)
        ? normalized.slice(PROMPT_PREFIX.length)
        : normalized;
      const detectionTarget = withoutPrompt.trim();
      if (detectionTarget.startsWith(`${exitMarker}:`)) {
        const code = Number.parseInt(
          detectionTarget.slice(exitMarker.length + 1),
          10,
        );
        if (!Number.isNaN(code)) {
          capturedExitCode = code;
        }
        return;
      }
      if (
        !this.options.verbose &&
        shouldSuppressLine(detectionTarget, exitMarker)
      ) {
        return;
      }
      const outputLine = !this.options.verbose ? withoutPrompt : line;
      if (outputLine.length > 0) {
        process.stdout.write(`${outputLine}\n`);
      }
    };

    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as TerminalFrame;
        switch (frame[0]) {
          case "stdout": {
            stdoutBuffer += frame[1];
            let newlineIndex = stdoutBuffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = stdoutBuffer.slice(0, newlineIndex);
              stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
              flushLine(line);
              newlineIndex = stdoutBuffer.indexOf("\n");
            }
            break;
          }
          case "stderr":
            process.stderr.write(frame[1]);
            break;
          case "disconnect":
            if (this.options.verbose) {
              console.log(chalk.yellow("Remote runtime disconnected."));
            }
            break;
          default:
            break;
        }
      } catch (error) {
        console.warn("Failed to parse terminal frame", error);
      }
    });

    const exitPromise = new Promise<number>((resolve, reject) => {
      ws.once("close", () => {
        if (stdoutBuffer.length > 0) {
          flushLine(stdoutBuffer);
          stdoutBuffer = "";
        }
        if (capturedExitCode === undefined) {
          console.warn(
            chalk.yellow(
              "Command finished without reporting an exit code; assuming failure (exit code 1).",
            ),
          );
          resolve(1);
          return;
        }
        resolve(capturedExitCode);
      });
      ws.once("error", (err) => {
        reject(err);
      });
    });

    const payload = [
      "stty -echo",
      "PS1=",
      command,
      "__COLAB_CLI_STATUS=$?",
      "stty echo",
      `printf '${exitMarker}:%s\\n' \"$__COLAB_CLI_STATUS\"`,
      "exit",
      "",
    ].join("\n");
    ws.send(JSON.stringify(["stdin", payload]));

    return exitPromise;
  }
}

interface RemoteCommandRunnerOptions {
  verbose?: boolean;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

function shouldSuppressLine(line: string, exitMarker: string): boolean {
  if (line.startsWith(`${exitMarker}:`)) {
    return true;
  }
  if (line.startsWith("printf '__COLAB_CLI_EXIT__")) {
    return true;
  }
  switch (line) {
    case "PS1=":
    case "stty -echo":
    case "stty echo":
    case "exit":
    case "logout":
      return true;
    default:
      return false;
  }
}
