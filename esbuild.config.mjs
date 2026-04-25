import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: `${outdir}/main.js`,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  sourcemap: "inline",
  external: ["obsidian"],
  logLevel: "info"
});

function copyPluginAssets() {
  mkdirSync(outdir, { recursive: true });
  copyFileSync("manifest.json", `${outdir}/manifest.json`);
  copyFileSync("styles.css", `${outdir}/styles.css`);
}

if (watch) {
  await context.watch();
  copyPluginAssets();
} else {
  await context.rebuild();
  copyPluginAssets();
  await context.dispose();
}
