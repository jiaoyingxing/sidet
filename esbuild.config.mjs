import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.argv.includes("production");

await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "main.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: path.join(rootDir, "main.js"),
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  legalComments: isProduction ? "none" : "inline",
  charset: "utf8",
  treeShaking: true,
  external: ["obsidian", "electron"],
  logLevel: "info"
});
