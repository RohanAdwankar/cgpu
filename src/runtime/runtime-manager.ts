import { randomUUID } from "crypto";
import chalk from "chalk";
import ora from "ora";
import type { Ora } from "ora";
import {
  ColabClient,
  ColabRequestError,
  TooManyAssignmentsError,
} from "../colab/client.js";
import { RuntimeProxyInfo, Variant } from "../colab/api.js";

export interface AssignedRuntime {
  label: string;
  accelerator: string;
  endpoint: string;
  proxy: RuntimeProxyInfo;
}

export interface AssignRuntimeOptions {
  /** Request a fresh runtime even if one is already assigned. */
  forceNew?: boolean;
  variant?: Variant;
  quiet?: boolean;
}

export class RuntimeManager {
  constructor(private readonly client: ColabClient) {}

  async assignRuntime(
    options: AssignRuntimeOptions = {},
  ): Promise<AssignedRuntime> {
    const variant = options.variant ?? Variant.GPU;
    const quiet = options.quiet ?? false;
    if (!options.forceNew) {
      const reused = await this.tryReuseExistingRuntime(variant, quiet);
      if (reused) {
        return reused;
      }
    }
    return this.requestFreshAssignment({
      allowFallbackToReuse: !options.forceNew,
      variant,
      quiet,
    });
  }

  private async requestFreshAssignment({
    allowFallbackToReuse,
    variant,
    quiet,
  }: {
    allowFallbackToReuse: boolean;
    variant: Variant;
    quiet: boolean;
  }): Promise<AssignedRuntime> {
    const spinner = this.createSpinner(
      `Requesting a fresh ${variantLabel(variant)} runtime from Colab...`,
      quiet,
    );
    const ccu = await this.client.getCcuInfo();
    const accelerators = this.pickAcceleratorsForVariant(ccu, variant);
    if (accelerators.length === 0) {
      throw new Error(
        `No eligible ${variantLabel(variant)} accelerators reported by Colab for this account.`,
      );
    }
    let lastError: unknown;
    for (const accelerator of accelerators) {
      spinner.start(
        `Requesting a fresh ${variantLabel(variant)} runtime (${accelerator}) from Colab...`,
      );
      try {
        const { assignment } = await this.client.assign(
          randomUUID(),
          variant,
          variant === Variant.DEFAULT ? undefined : accelerator,
        );
        if (!assignment.runtimeProxyInfo) {
          throw new Error("Assignment missing runtime proxy information");
        }
        spinner.succeed(
          `Assigned ${variantLabel(variant)} runtime ${chalk.green(assignment.accelerator ?? accelerator)}`,
        );
        return {
          label: `Colab ${variantLabel(variant)} ${assignment.accelerator ?? accelerator}`,
          accelerator: assignment.accelerator ?? accelerator,
          endpoint: assignment.endpoint,
          proxy: assignment.runtimeProxyInfo,
        };
      } catch (err) {
        lastError = err;
        if (err instanceof TooManyAssignmentsError) {
          spinner.warn(
            `Colab says you already have the maximum number of ${variantLabel(variant)} runtimes.`,
          );
          if (!allowFallbackToReuse) {
            throw new Error(
              `Colab refused to attach a brand-new ${variantLabel(variant)} runtime. Disconnect existing sessions from the Colab UI or rerun without --new-runtime to reuse one.`,
            );
          }
          const reused = await this.forceReuseAfterCap(variant, quiet);
          if (reused) {
            return reused;
          }
          throw err;
        }

        if (isRetryableColabError(err)) {
          spinner.warn(
            `Colab temporarily failed to assign ${variantLabel(variant)} accelerator ${chalk.green(accelerator)} (${err.response.statusText}). Trying another option...`,
          );
          continue;
        }

        spinner.fail("Failed to assign runtime");
        throw err;
      }
    }
    const message = buildExhaustedAcceleratorsMessage(variant, accelerators);
    spinner.fail(message);
    throw new RuntimeAssignmentUnavailableError(message, {
      cause: lastError,
    });
  }

  private async tryReuseExistingRuntime(
    variant: Variant,
    quiet: boolean,
  ): Promise<AssignedRuntime | undefined> {
    const spinner = this.createSpinner(
      `Checking for existing Colab ${variantLabel(variant)} runtimes...`,
      quiet,
    );
    try {
      const assignment = await this.findReusableAssignment(variant);
      if (!assignment) {
        spinner.info(
          `No existing ${variantLabel(variant)} runtimes found. Requesting a new one...`,
        );
        return undefined;
      }
      const runtime = await this.runtimeFromAssignment(assignment, variant);
      spinner.succeed(
        `Reusing ${variantLabel(variant)} runtime ${chalk.green(runtime.accelerator)}`,
      );
      return runtime;
    } catch (err) {
      spinner.warn(
        `Failed to check for existing ${variantLabel(variant)} runtimes. Attempting to request a new one...`,
      );
      return undefined;
    }
  }

  private async forceReuseAfterCap(
    variant: Variant,
    quiet: boolean,
  ): Promise<AssignedRuntime | undefined> {
    const spinner = this.createSpinner(
      `Reconnecting to an existing Colab ${variantLabel(variant)} runtime...`,
      quiet,
    );
    try {
      const assignment = await this.findReusableAssignment(variant);
      if (!assignment) {
        spinner.fail(
          "Colab reported an assignment cap, but no active runtimes were returned.",
        );
        throw new Error(
          "Disconnect other runtimes from https://colab.research.google.com/ and try again.",
        );
      }
      const runtime = await this.runtimeFromAssignment(assignment, variant);
      spinner.succeed(
        `Reusing ${variantLabel(variant)} runtime ${chalk.green(runtime.accelerator)}`,
      );
      return runtime;
    } catch (err) {
      spinner.fail(
        "Failed to reuse an existing runtime after hitting the assignment cap.",
      );
      throw err;
    }
  }

  private async findReusableAssignment(variant: Variant) {
    const assignments = await this.client.listAssignments();
    return assignments.find((assignment) => assignment.variant === variant);
  }

  private async runtimeFromAssignment(
    assignment: {
      accelerator: string;
      endpoint: string;
    },
    variant: Variant,
  ): Promise<AssignedRuntime> {
    const proxy = await this.client.refreshConnection(assignment.endpoint);
    return {
      label: `Colab ${variantLabel(variant)} ${assignment.accelerator}`,
      accelerator: assignment.accelerator,
      endpoint: assignment.endpoint,
      proxy,
    };
  }

  private pickAcceleratorsForVariant(
    ccu: { eligibleGpus: string[]; eligibleTpus: string[] },
    variant: Variant,
  ): string[] {
    switch (variant) {
      case Variant.TPU:
        return [...ccu.eligibleTpus];
      case Variant.DEFAULT:
        return ["CPU"];
      case Variant.GPU:
      default:
        return prioritizeGpus(ccu.eligibleGpus);
    }
  }

  private createSpinner(message: string, quiet: boolean): Spinner {
    if (quiet) {
      return new SilentSpinner();
    }
    return new ActiveSpinner(ora(message).start());
  }
}

export function pickAccelerator(gpus: string[]): string | undefined {
  return prioritizeGpus(gpus)[0];
}

function prioritizeGpus(gpus: string[]): string[] {
  if (gpus.length === 0) {
    return [];
  }
  const preferredPattern = /^(A100|L4|P100|T4|V100)$/i;
  const preferred: string[] = [];
  const others: string[] = [];
  for (const gpu of gpus) {
    if (preferredPattern.test(gpu)) {
      preferred.push(gpu);
    } else {
      others.push(gpu);
    }
  }
  return [...preferred, ...others];
}

function variantLabel(variant: Variant): string {
  switch (variant) {
    case Variant.DEFAULT:
      return "CPU";
    case Variant.TPU:
      return "TPU";
    case Variant.GPU:
    default:
      return "GPU";
  }
}

function isRetryableColabError(err: unknown): err is ColabRequestError {
  return (
    err instanceof ColabRequestError &&
    err.response.status >= 500 &&
    err.response.status < 600
  );
}

function buildExhaustedAcceleratorsMessage(
  variant: Variant,
  accelerators: string[],
): string {
  const label = variantLabel(variant);
  const suggestion = (() => {
    switch (variant) {
      case Variant.TPU:
        return "Give it a minute and retry, or rerun without --tpu to fall back to GPUs.";
      case Variant.DEFAULT:
        return "Give it a minute and retry, or rerun without --cpu to request a GPU.";
      case Variant.GPU:
      default:
        return "Give it a minute and retry, or reuse/disconnect runtimes from the Colab UI.";
    }
  })();
  const list = accelerators.join(", ") || "no accelerators reported";
  return `Colab is temporarily out of ${label} capacity for this account (tried: ${list}). ${suggestion}`;
}

export class RuntimeAssignmentUnavailableError extends Error {
  readonly alreadyReported = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeAssignmentUnavailableError";
  }
}

interface Spinner {
  start(text?: string): Spinner;
  succeed(text?: string): Spinner;
  fail(text?: string): Spinner;
  warn(text?: string): Spinner;
  info(text?: string): Spinner;
}

class SilentSpinner implements Spinner {
  start() {
    return this;
  }
  succeed() {
    return this;
  }
  fail() {
    return this;
  }
  warn() {
    return this;
  }
  info() {
    return this;
  }
}

class ActiveSpinner implements Spinner {
  constructor(private readonly spinner: Ora) {}

  start(text?: string) {
    if (text !== undefined) {
      this.spinner.start(text);
    } else {
      this.spinner.start();
    }
    return this;
  }

  succeed(text?: string) {
    this.spinner.succeed(text);
    return this;
  }

  fail(text?: string) {
    this.spinner.fail(text);
    return this;
  }

  warn(text?: string) {
    this.spinner.warn(text);
    return this;
  }

  info(text?: string) {
    this.spinner.info(text);
    return this;
  }
}
