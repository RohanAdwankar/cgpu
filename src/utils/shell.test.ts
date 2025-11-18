import { describe, expect, it } from "vitest";
import { buildPosixCommand, quotePosixArgForCommand } from "./shell.js";

describe("quotePosixArgForCommand", () => {
  it("leaves safe strings untouched", () => {
    expect(quotePosixArgForCommand("python")).toBe("python");
    expect(quotePosixArgForCommand("FOO=bar")).toBe("FOO=bar");
  });

  it("quotes strings containing spaces", () => {
    expect(quotePosixArgForCommand("hello world")).toBe("'hello world'");
  });

  it("escapes single quotes", () => {
    expect(quotePosixArgForCommand("O'Reilly")).toBe("'O'\"'\"'Reilly'");
  });
});

describe("buildPosixCommand", () => {
  it("joins multiple args", () => {
    expect(buildPosixCommand(["nvcc", "-o", "matmul"]).toString()).toBe(
      "nvcc -o matmul",
    );
  });

  it("quotes args with spaces when building command", () => {
    expect(
      buildPosixCommand(["python", "-c", "print('hi there')"], {
        quoteFirstArg: true,
      }),
    ).toBe("python -c 'print('\"'\"'hi there'\"'\"')'");
  });

  it("does not quote the command name by default", () => {
    expect(buildPosixCommand(["ls", "-la"])).toBe("ls -la");
  });
});
