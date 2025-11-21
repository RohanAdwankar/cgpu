import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { startServeServer } from "../src/serve/server.js";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const MOCK_GEMINI = path.join(FIXTURES_DIR, "mock-gemini.js");

describe("cgpu serve", () => {
  let server: http.Server | undefined;

  beforeAll(async () => {
    await fs.mkdir(FIXTURES_DIR, { recursive: true });
    await fs.writeFile(MOCK_GEMINI, `#!/usr/bin/env node
console.log(JSON.stringify({
  response: "Mock response",
  stats: { total_tokens: 10, input_tokens: 5, output_tokens: 5 }
}));
`);
    await fs.chmod(MOCK_GEMINI, 0o755);
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it("should handle create response request", async () => {
    server = await startServeServer({
      port: 0, // Random port
      geminiBin: MOCK_GEMINI,
      logger: { log: () => {}, error: console.error },
    });
    
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address not found");
    }
    const baseUrl = `http://localhost:${address.port}`;

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "Hello",
        model: "gemini-2.0-flash"
      })
    });

    expect(response.status).toBe(200);
    interface ErrorResponse { error: { code: string; message?: string } }
    const data = await response.json() as any;
    expect(data.object).toBe("response");
    expect(data.output_text).toBe("Mock response");
    expect(data.usage.total_tokens).toBe(10);
    expect(data.model).toBe("gemini-2.0-flash");
  });

  it("should return 400 for missing input", async () => {
    server = await startServeServer({
      port: 0,
      geminiBin: MOCK_GEMINI,
      logger: { log: () => {}, error: console.error },
    });
    
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address not found");
    }
    const baseUrl = `http://localhost:${address.port}`;

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash"
      })
    });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.code).toBe("missing_input");
  });

  it("should handle OpenAI client style request with instructions", async () => {
    server = await startServeServer({
      port: 0,
      geminiBin: MOCK_GEMINI,
      logger: { log: () => {}, error: console.error },
    });
    
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address not found");
    }
    const baseUrl = `http://localhost:${address.port}`;

    // Mimic OpenAI Python client: client.responses.create(...)
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5",
        instructions: "You are a coding assistant that talks like a pirate.",
        input: "How do I check if a Python object is an instance of a class?"
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.object).toBe("response");
    expect(data.model).toBe("gemini-2.5");
    // The mock returns fixed text, but we verify the request was accepted and processed
    expect(data.output_text).toBe("Mock response");
    expect(data.instructions).toBe("You are a coding assistant that talks like a pirate.");
  });
});
