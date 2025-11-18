import { describe, expect, it } from "vitest";
import path from "node:path";
import { encodeContentsPath, resolveRemotePath } from "./file-transfer.js";

describe("resolveRemotePath", () => {
  it("defaults to /content/<basename> when destination missing", () => {
    const local = path.join("/tmp", "matmul.cu");
    const result = resolveRemotePath(undefined, local);
    expect(result.relative).toBe("content/matmul.cu");
    expect(result.display).toBe("/content/matmul.cu");
  });

  it("strips leading slashes and normalizes windows separators", () => {
    const local = path.join("C:", "projects", "main.cu");
    const result = resolveRemotePath("\\content\\kernels\\main.cu", local);
    expect(result.relative).toBe("content/kernels/main.cu");
  });

  it("prevents directory traversal segments", () => {
    const local = "/tmp/model.bin";
    const result = resolveRemotePath("../secrets/model.bin", local);
    expect(result.relative).toBe("secrets/model.bin");
  });
});

describe("encodeContentsPath", () => {
  it("encodes each path segment", () => {
    expect(encodeContentsPath("content/my file.txt")).toBe(
      "content/my%20file.txt",
    );
  });
});
