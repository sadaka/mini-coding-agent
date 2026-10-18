export interface ContextPolicy {
  maxContextTokens: number;
  reservedOutputTokens: number;
  compactionThreshold: number;
  maxToolResultTokens: number;
  maxFileReadTokens: number;
  maxSearchResultTokens: number;
  maxCommandOutputTokens: number;
  maxRecentItems: number;
  enableDuplicateRemoval: boolean;
  enableCompaction: boolean;
}

export function loadContextPolicy(
  env: NodeJS.ProcessEnv = process.env,
  // The caller passes the provider's real context window here. Without it the 32000
  // fallback made compaction fire at ~22K while the build budget was the provider's
  // full window, so context was discarded with most of the window still free.
  // An explicit MAX_CONTEXT_TOKENS still wins.
  defaults: { maxContextTokens?: number } = {},
): ContextPolicy {
  return {
    maxContextTokens: parseInt(
      env.MAX_CONTEXT_TOKENS ?? String(defaults.maxContextTokens ?? 32000),
      10,
    ),
    reservedOutputTokens: parseInt(env.RESERVED_OUTPUT_TOKENS ?? "4096", 10),
    compactionThreshold: parseFloat(env.COMPACTION_THRESHOLD ?? "0.80"),
    maxToolResultTokens: parseInt(env.MAX_TOOL_OUTPUT_TOKENS ?? "4000", 10),
    maxFileReadTokens: parseInt(env.MAX_FILE_READ_TOKENS ?? "6000", 10),
    maxSearchResultTokens: parseInt(env.MAX_SEARCH_RESULT_TOKENS ?? "2000", 10),
    maxCommandOutputTokens: parseInt(env.MAX_COMMAND_OUTPUT_TOKENS ?? "4000", 10),
    maxRecentItems: parseInt(env.MAX_RECENT_ITEMS ?? "8", 10),
    enableDuplicateRemoval: (env.ENABLE_DUPLICATE_REMOVAL ?? "true") !== "false",
    enableCompaction: (env.ENABLE_COMPACTION ?? "true") !== "false",
  };
}

export function usableInputTokens(policy: ContextPolicy): number {
  return policy.maxContextTokens - policy.reservedOutputTokens;
}
