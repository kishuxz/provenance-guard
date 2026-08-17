import type { Grounding } from "@provguard/schema";

export interface JudgeFixture {
  key: string;
  grounding: Omit<Grounding, "claimId" | "method">;
  note: string;
}

export const DEFAULT_FIXTURES = [
  {
    key: "sha256:20be4d8a2ac355137c72bfd66b26569a9c7825a39e2f00381fcf96a82a60e392",
    grounding: {
      status: "ungrounded",
      supportingChunkIds: [],
      score: 0,
    },
    note: "hard-split-conjunction: the context states two same-day facts but does not support the causal claim that the configuration change resolved the incident.",
  },
] as const satisfies readonly JudgeFixture[];
