import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "public", "workspace.js");

await build({
  entryPoints: [join(here, "ui", "workspace.jsx")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  legalComments: "eof",
  logLevel: "info",
  minify: true,
  sourcemap: false,
});

const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/[ \t]+$/gmu, ""), "utf8");
