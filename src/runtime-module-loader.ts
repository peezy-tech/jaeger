import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  ResolveFnOutput,
  ResolveHookContext,
} from "node:module";

const DIGEST_PARAMETER = "jaeger-runtime-digest";

interface RuntimeModuleLoaderData {
  readonly root: string;
  readonly digest: string;
}

let root: string;
let digest: string;

export function initialize(data: RuntimeModuleLoaderData): void {
  root = data.root;
  digest = data.digest;
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
  if (parent.searchParams.get(DIGEST_PARAMETER) !== digest) return resolved;

  const target = new URL(resolved.url);
  if (target.protocol !== "file:" || !contains(root, fileURLToPath(target))) {
    return resolved;
  }
  target.searchParams.set(DIGEST_PARAMETER, digest);
  return { ...resolved, url: target.href };
}

function contains(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
