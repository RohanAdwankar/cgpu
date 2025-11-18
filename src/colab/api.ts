/**
 * Copied from the official VS Code extension to preserve schema parity.
 */
import { z } from "zod";

export enum SubscriptionState {
  UNSUBSCRIBED = 1,
  RECURRING = 2,
  NON_RECURRING = 3,
  PENDING_ACTIVATION = 4,
  DECLINED = 5,
}

export enum SubscriptionTier {
  NONE = 0,
  PRO = 1,
  PRO_PLUS = 2,
}

enum ColabSubscriptionTier {
  UNKNOWN = 0,
  PRO = 1,
  VERY_PRO = 2,
}

enum ColabGapiSubscriptionTier {
  UNSPECIFIED = "SUBSCRIPTION_TIER_UNSPECIFIED",
  NONE = "SUBSCRIPTION_TIER_NONE",
  PRO = "SUBSCRIPTION_TIER_PRO",
  PRO_PLUS = "SUBSCRIPTION_TIER_PRO_PLUS",
}

export enum Outcome {
  UNDEFINED_OUTCOME = 0,
  QUOTA_DENIED_REQUESTED_VARIANTS = 1,
  QUOTA_EXCEEDED_USAGE_TIME = 2,
  SUCCESS = 4,
  DENYLISTED = 5,
}

export enum Variant {
  DEFAULT = "DEFAULT",
  GPU = "GPU",
  TPU = "TPU",
}

enum ColabGapiVariant {
  UNSPECIFIED = "VARIANT_UNSPECIFIED",
  GPU = "VARIANT_GPU",
  TPU = "VARIANT_TPU",
}

export enum Shape {
  STANDARD = 0,
  HIGHMEM = 1,
}

function normalizeSubTier(
  tier: ColabSubscriptionTier | ColabGapiSubscriptionTier,
): SubscriptionTier {
  switch (tier) {
    case ColabSubscriptionTier.PRO:
    case ColabGapiSubscriptionTier.PRO:
      return SubscriptionTier.PRO;
    case ColabSubscriptionTier.VERY_PRO:
    case ColabGapiSubscriptionTier.PRO_PLUS:
      return SubscriptionTier.PRO_PLUS;
    default:
      return SubscriptionTier.NONE;
  }
}

function normalizeVariant(variant: ColabGapiVariant): Variant {
  switch (variant) {
    case ColabGapiVariant.GPU:
      return Variant.GPU;
    case ColabGapiVariant.TPU:
      return Variant.TPU;
    case ColabGapiVariant.UNSPECIFIED:
      return Variant.DEFAULT;
  }
}

export const UserInfoSchema = z.object({
  subscriptionTier: z
    .nativeEnum(ColabGapiSubscriptionTier)
    .transform(normalizeSubTier),
  paidComputeUnitsBalance: z.number().optional(),
  eligibleAccelerators: z
    .array(
      z.object({
        variant: z
          .nativeEnum(ColabGapiVariant)
          .transform(normalizeVariant),
        models: z.array(z.string().toUpperCase()),
      }),
    )
    .optional(),
});

export const CcuInfoSchema = z.object({
  currentBalance: z.number(),
  consumptionRateHourly: z.number(),
  assignmentsCount: z.number(),
  eligibleGpus: z.array(z.string().toUpperCase()),
  ineligibleGpus: z.array(z.string().toUpperCase()).optional(),
  eligibleTpus: z.array(z.string().toUpperCase()),
  ineligibleTpus: z.array(z.string().toUpperCase()).optional(),
  freeCcuQuotaInfo: z
    .object({
      remainingTokens: z
        .string()
        .refine((val) => Number.isSafeInteger(Number(val)), {
          message: "Value too large to be a safe integer for JavaScript",
        })
        .transform((val) => Number(val)),
      nextRefillTimestampSec: z.number(),
    })
    .optional(),
});
export type CcuInfo = z.infer<typeof CcuInfoSchema>;

export const GetAssignmentResponseSchema = z
  .object({
    acc: z.string().toUpperCase(),
    nbh: z.string(),
    p: z.boolean(),
    token: z.string(),
    variant: z.nativeEnum(Variant),
  })
  .transform(({ acc, nbh, p, token, ...rest }) => ({
    ...rest,
    accelerator: acc,
    notebookIdHash: nbh,
    shouldPromptRecaptcha: p,
    xsrfToken: token,
  }));
export type GetAssignmentResponse = z.infer<typeof GetAssignmentResponseSchema>;

export const RuntimeProxyInfoSchema = z.object({
  token: z.string(),
  tokenExpiresInSeconds: z.number(),
  url: z.string(),
});
export type RuntimeProxyInfo = z.infer<typeof RuntimeProxyInfoSchema>;

export const PostAssignmentResponseSchema = z.object({
  accelerator: z.string().toUpperCase().optional(),
  endpoint: z.string().optional(),
  fit: z.number().optional(),
  allowedCredentials: z.boolean().optional(),
  sub: z.nativeEnum(SubscriptionState).optional(),
  subTier: z
    .nativeEnum(ColabSubscriptionTier)
    .transform(normalizeSubTier)
    .optional(),
  outcome: z.nativeEnum(Outcome).optional(),
  variant: z.preprocess((val) => {
    if (typeof val === "number") {
      switch (val) {
        case 0:
          return Variant.DEFAULT;
        case 1:
          return Variant.GPU;
        case 2:
          return Variant.TPU;
      }
    }
    return val;
  }, z.nativeEnum(Variant).optional()),
  machineShape: z.nativeEnum(Shape).optional(),
  runtimeProxyInfo: RuntimeProxyInfoSchema.optional(),
});
export type PostAssignmentResponse = z.infer<
  typeof PostAssignmentResponseSchema
>;

export const ListedAssignmentSchema = PostAssignmentResponseSchema.required({
  accelerator: true,
  endpoint: true,
  variant: true,
  machineShape: true,
}).omit({
  fit: true,
  allowedCredentials: true,
  sub: true,
  subTier: true,
  outcome: true,
  runtimeProxyInfo: true,
});
export type ListedAssignment = z.infer<typeof ListedAssignmentSchema>;

export const ListedAssignmentsSchema = z.object({
  assignments: z.array(ListedAssignmentSchema),
});
export type ListedAssignments = z.infer<typeof ListedAssignmentsSchema>;

export const AssignmentSchema = PostAssignmentResponseSchema.omit({
  outcome: true,
})
  .required({
    accelerator: true,
    endpoint: true,
    variant: true,
    machineShape: true,
    runtimeProxyInfo: true,
  })
  .transform(({ fit, sub, subTier, ...rest }) => ({
    ...rest,
    idleTimeoutSec: fit,
    subscriptionState: sub,
    subscriptionTier: subTier,
  }));
export type Assignment = z.infer<typeof AssignmentSchema>;

export const KernelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    last_activity: z.string().datetime(),
    execution_state: z.string(),
    connections: z.number(),
  })
  .transform(({ last_activity, execution_state, ...rest }) => ({
    ...rest,
    lastActivity: last_activity,
    executionState: execution_state,
  }));
export type Kernel = z.infer<typeof KernelSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  kernel: KernelSchema,
  name: z.string(),
  path: z.string(),
  type: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

export function variantToMachineType(variant: Variant): string {
  switch (variant) {
    case Variant.DEFAULT:
      return "CPU";
    case Variant.GPU:
      return "GPU";
    case Variant.TPU:
      return "TPU";
  }
}
