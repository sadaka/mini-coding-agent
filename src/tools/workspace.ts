import { resolve, normalize } from "node:path";

export function assertInWorkspace(workspaceRoot: string, targetPath: string): string {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(workspaceRoot, targetPath);
  if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
    throw new Error(`Path is outside the workspace: ${targetPath}`);
  }
  return resolvedTarget;
}

export function resolveInWorkspace(workspaceRoot: string, targetPath: string): string {
  return assertInWorkspace(workspaceRoot, normalize(targetPath));
}
