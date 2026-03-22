import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
});

if (watch) {
  await ctx.watch();
  console.log("Pulse extension build watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Pulse extension build completed.");
}
