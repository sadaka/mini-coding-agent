import type { Tool } from "../types/index.js";
import { createFindSymbolTool } from "./find-symbol.js";
import { createFindTestsTool } from "./find-tests.js";
import { createListDirectoryTool } from "./list-directory.js";
import { createRepositoryScope } from "./scope.js";
import type { NavigationState } from "./state.js";

/** Structural, so navigation does not import the tools layer; ToolRegistry satisfies it. */
export interface ToolSink {
  register(tool: Tool): void;
}

/** Records every call in `state`, then runs the tool unchanged: repeats are recorded, never blocked (FR-57). */
function recording(tool: Tool, state: NavigationState): Tool {
  return {
    definition: tool.definition,
    async execute(input) {
      const result = await tool.execute(input);
      state.record(tool.definition.name, input, result);
      return result;
    },
  };
}

/**
 * Registers list_directory, find_symbol and find_tests. Call once per task with a fresh (or reset) state: the
 * repository scope probes git once and is not refreshed (see scope.ts), so it is also per task.
 */
export function registerNavigationTools(registry: ToolSink, root: string, state: NavigationState): void {
  const scope = createRepositoryScope(root);
  for (const tool of [createListDirectoryTool(scope), createFindSymbolTool(root), createFindTestsTool(scope)]) {
    registry.register(recording(tool, state));
  }
}
