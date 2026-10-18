import type { SymbolProvider } from "./types.js";

const providers = new Map<string, SymbolProvider>();

const normalize = (ext: string) => (ext.startsWith(".") ? ext : "." + ext).toLowerCase();

/** Rejects the whole registration if any extension is already taken. */
export function registerSymbolProvider(provider: SymbolProvider): void {
  const exts = provider.extensions.map(normalize);
  const taken = exts.find((e) => providers.has(e));
  if (taken) throw new Error(`Symbol provider already registered for ${taken} (${providers.get(taken)!.language})`);
  for (const e of exts) providers.set(e, provider);
}

/** Unsupported extension returns undefined; callers fall back to text search. */
export function getProviderForExtension(ext: string): SymbolProvider | undefined {
  return providers.get(normalize(ext));
}

/** For tests only. */
export function clearSymbolProviders(): void {
  providers.clear();
}
