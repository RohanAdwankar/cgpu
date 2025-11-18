import fetch from "node-fetch";
import WebSocket from "ws";
import chalk from "chalk";
import { AssignedRuntime } from "./runtime-manager.js";
import { ColabClient } from "../colab/client.js";
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from "../colab/headers.js";

export class TerminalSession {
  private keepAliveTimer?: NodeJS.Timeout;

  constructor(
    private readonly client: ColabClient,
    private readonly runtime: AssignedRuntime,
    private readonly options: TerminalSessionOptions = {},
  ) {}

  async start(): Promise<void> {
    const terminalName = await this.createRemoteTerminal();
    console.log(
      chalk.gray(
        `Opening terminal session ${terminalName} on ${this.runtime.label}...`,
      ),
    );
    await this.attachToTerminal(terminalName);
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

  private async attachToTerminal(name: string): Promise<void> {
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

    ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString()) as TerminalFrame;
        this.handleFrame(payload);
      } catch (err) {
        console.error("Failed to parse terminal frame", err);
      }
    });

    ws.on("close", () => {
      console.log(chalk.yellow("Terminal session closed."));
      this.cleanup(ws);
    });

    this.setupIoForwarding(ws);
    this.beginKeepAlive();
    console.log(chalk.green("Connected! Use Ctrl+C twice to exit."));
    if (this.options.startupCommand) {
      ws.send(JSON.stringify(["stdin", `${this.options.startupCommand}\n`]));
    }
  }

  private setupIoForwarding(ws: WebSocket) {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    let lastCtrlC = 0;
    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      if (data === "\u0003") {
        const now = Date.now();
        if (now - lastCtrlC < 1000) {
          console.log(chalk.yellow("Exiting local session..."));
          process.exit(0);
        }
        lastCtrlC = now;
      }
      ws.send(JSON.stringify(["stdin", data]));
    };
    process.stdin.on("data", onData);

    const sendSize = () => {
      if (!process.stdout.isTTY) {
        return;
      }
      ws.send(
        JSON.stringify([
          "set_size",
          process.stdout.rows,
          process.stdout.columns,
          0,
          0,
        ]),
      );
    };
    process.stdout.on("resize", sendSize);
    sendSize();

    ws.once("close", () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.off("resize", sendSize);
    });
  }

  private handleFrame(frame: TerminalFrame) {
    const [type, payload] = frame;
    switch (type) {
      case "stdout":
        process.stdout.write(payload);
        break;
      case "disconnect":
        console.log("Remote runtime disconnected.");
        break;
      default:
        break;
    }
  }

  private beginKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      void this.client.sendKeepAlive(this.runtime.endpoint).catch((err) => {
        console.warn("Failed to send keep-alive", err);
      });
    }, 60_000);
  }

  private cleanup(ws: WebSocket) {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}

interface TerminalSessionOptions {
  startupCommand?: string;
}

type TerminalFrame =
  | ["stdout", string]
  | ["disconnect", string]
  | ["stderr", string]
  | ["set_size", number, number, number, number]
  | ["stdin", string];
