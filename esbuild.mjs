import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

// Extension (Node.js)
const extCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
});

// Webview (browser)
const webCtx = await esbuild.context({
  entryPoints: ["src/webview/sidebar.ts"],
  bundle: true,
  outfile: "dist/sidebar.js",
  platform: "browser",
  format: "iife",
  sourcemap: true,
  target: "es2020",
  minify: !watch,
});

if (watch) {
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log("Pulse extension + webview build watching...");
} else {
  await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), webCtx.dispose()]);
  console.log("Pulse extension + webview build completed.");
}
