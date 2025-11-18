import { describe, expect, it, vi } from "vitest";
import { Request, Response } from "node-fetch";
import { Variant } from "../colab/api.js";
import {
  ColabClient,
  ColabRequestError,
  TooManyAssignmentsError,
} from "../colab/client.js";
import {
  RuntimeManager,
  pickAccelerator,
} from "./runtime-manager.js";

describe("pickAccelerator", () => {
  it("prefers modern GPUs", () => {
    expect(pickAccelerator(["K80", "A100", "P100"])).toBe("A100");
  });

  it("falls back to first entry", () => {
    const fallback = pickAccelerator(["K80", "P4"]);
    expect(fallback).toBeDefined();
    expect(fallback?.toUpperCase()).toBe("K80");
  });

  it("returns undefined when no GPUs", () => {
    expect(pickAccelerator([])).toBeUndefined();
  });
});

describe("RuntimeManager", () => {
  const baseCcuInfo = {
    currentBalance: 1,
    consumptionRateHourly: 1,
    assignmentsCount: 1,
    eligibleGpus: ["T4"],
    eligibleTpus: [],
  };

  it("reuses an existing GPU runtime before requesting a new one", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue(baseCcuInfo),
      assign: vi.fn(),
      listAssignments: vi.fn().mockResolvedValue([
        {
          accelerator: "T4",
          endpoint: "endpoint-123",
          variant: Variant.GPU,
          machineShape: 0,
        },
      ]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };

    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );
    const assignment = await runtimeManager.assignRuntime();

    expect(assignment.endpoint).toBe("endpoint-123");
    expect(mockClient.assign).not.toHaveBeenCalled();
    expect(mockClient.refreshConnection).toHaveBeenCalledWith("endpoint-123");
  });

  it("requests a new runtime when forced and surfaces cap errors", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue(baseCcuInfo),
      assign: vi
        .fn()
        .mockRejectedValue(new TooManyAssignmentsError("cap reached")),
      listAssignments: vi.fn().mockResolvedValue([
        {
          accelerator: "T4",
          endpoint: "endpoint-123",
          variant: Variant.GPU,
          machineShape: 0,
        },
      ]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };
    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );

    await expect(
      runtimeManager.assignRuntime({ forceNew: true }),
    ).rejects.toThrow(/refused to attach a brand-new gpu runtime/i);
  });

  it("requests a TPU runtime when flagged", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue({
        ...baseCcuInfo,
        eligibleGpus: [],
        eligibleTpus: ["V2-8"],
      }),
      assign: vi.fn().mockResolvedValue({
        assignment: {
          accelerator: "V2-8",
          endpoint: "endpoint-tpu",
          variant: Variant.TPU,
          machineShape: 0,
          runtimeProxyInfo: {
            token: "token",
            tokenExpiresInSeconds: 60,
            url: "https://example.com",
          },
        },
        isNew: true,
      }),
      listAssignments: vi.fn().mockResolvedValue([]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };

    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );
    const runtime = await runtimeManager.assignRuntime({
      forceNew: true,
      variant: Variant.TPU,
    });

    expect(mockClient.assign).toHaveBeenCalledWith(
      expect.any(String),
      Variant.TPU,
      "V2-8",
    );
    expect(runtime.label).toContain("TPU");
  });

  it("requests a CPU runtime when flagged", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue(baseCcuInfo),
      assign: vi.fn().mockResolvedValue({
        assignment: {
          accelerator: "CPU",
          endpoint: "endpoint-cpu",
          variant: Variant.DEFAULT,
          machineShape: 0,
          runtimeProxyInfo: {
            token: "token",
            tokenExpiresInSeconds: 60,
            url: "https://example.com",
          },
        },
        isNew: true,
      }),
      listAssignments: vi.fn().mockResolvedValue([]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };

    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );
    const runtime = await runtimeManager.assignRuntime({
      forceNew: true,
      variant: Variant.DEFAULT,
    });

    expect(mockClient.assign).toHaveBeenCalledWith(
      expect.any(String),
      Variant.DEFAULT,
      undefined,
    );
    expect(runtime.label).toContain("CPU");
  });

  it("retries alternate accelerators after transient failures", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue({
        ...baseCcuInfo,
        eligibleGpus: [],
        eligibleTpus: ["V5E1", "V4-8"],
      }),
      assign: vi.fn().mockImplementation(async (_, __, accelerator) => {
        if (accelerator === "V5E1") {
          throw new ColabRequestError({
            request: new Request("https://colab.example/assign"),
            response: new Response(null, {
              status: 503,
              statusText: "Service Unavailable",
            }),
          });
        }
        return {
          assignment: {
            accelerator,
            endpoint: `endpoint-${accelerator}`,
            variant: Variant.TPU,
            machineShape: 0,
            runtimeProxyInfo: {
              token: "token",
              tokenExpiresInSeconds: 60,
              url: "https://example.com",
            },
          },
          isNew: true,
        };
      }),
      listAssignments: vi.fn().mockResolvedValue([]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };

    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );
    const runtime = await runtimeManager.assignRuntime({
      forceNew: true,
      variant: Variant.TPU,
    });

    expect(mockClient.assign).toHaveBeenCalledTimes(2);
    expect(mockClient.assign).toHaveBeenCalledWith(
      expect.any(String),
      Variant.TPU,
      "V5E1",
    );
    expect(mockClient.assign).toHaveBeenCalledWith(
      expect.any(String),
      Variant.TPU,
      "V4-8",
    );
    expect(runtime.accelerator).toBe("V4-8");
    expect(runtime.label).toContain("TPU");
  });

  it("surfaces a helpful error when every accelerator fails", async () => {
    const mockClient: Partial<ColabClient> = {
      getCcuInfo: vi.fn().mockResolvedValue({
        ...baseCcuInfo,
        eligibleGpus: [],
        eligibleTpus: ["V5E1"],
      }),
      assign: vi.fn().mockImplementation(async () => {
        throw new ColabRequestError({
          request: new Request("https://colab.example/assign"),
          response: new Response(null, {
            status: 503,
            statusText: "Service Unavailable",
          }),
        });
      }),
      listAssignments: vi.fn().mockResolvedValue([]),
      refreshConnection: vi.fn().mockResolvedValue({
        token: "token",
        tokenExpiresInSeconds: 60,
        url: "https://example.com",
      }),
    };

    const runtimeManager = new RuntimeManager(
      mockClient as unknown as ColabClient,
    );

    await expect(
      runtimeManager.assignRuntime({ forceNew: true, variant: Variant.TPU }),
    ).rejects.toThrow(/temporarily out of tpu capacity/i);
  });
});
