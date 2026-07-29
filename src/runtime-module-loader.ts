import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  ResolveFnOutput,
  ResolveHookContext,
} from "node:module";

const DIGEST_PARAMETER = "jaeger-runtime-digest";

interface RuntimeModuleLoaderData {
  readonly root: string;
}

// Node evaluates this hook module once and calls initialize() once per
// register(), so registered roots accumulate here instead of overwriting each
// other. The digest itself travels on the importing parent's URL, so a project
// that reloads under a new digest never needs another registration.
const roots = new Set<string>();

export function initialize(data: RuntimeModuleLoaderData): void {
  roots.add(data.root);
}

export async function resolve(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (
    specifier: string,
    context?: Partial<ResolveHookContext>,
  ) => ResolveFnOutput | Promise<ResolveFnOutput>,
): Promise<ResolveFnOutput> {
  const resolved = await nextResolve(specifier, context);
  if (!context.parentURL) return resolved;

  const parent = new URL(context.parentURL);
  const digest = parent.searchParams.get(DIGEST_PARAMETER);
  if (!digest) return resolved;

  const target = new URL(resolved.url);
  if (target.protocol !== "file:") return resolved;
  const file = fileURLToPath(target);
  if (![...roots].some((root) => contains(root, file))) return resolved;
  target.searchParams.set(DIGEST_PARAMETER, digest);
  return { ...resolved, url: target.href };
}

function contains(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
