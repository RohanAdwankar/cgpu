interface BuildCommandOptions {
  quoteFirstArg?: boolean;
}

export function buildPosixCommand(
  args: string[],
  options: BuildCommandOptions = {},
): string {
  if (args.length === 0) {
    throw new Error("At least one argument is required to build a command");
  }
  const { quoteFirstArg = false } = options;
  return args
    .map((arg, index) => {
      if (index === 0 && !quoteFirstArg) {
        return arg;
      }
      return quotePosixArg(arg);
    })
    .join(" ");
}

function quotePosixArg(arg: string): string {
  if (arg === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

export { quotePosixArg as quotePosixArgForCommand };
