/**
 * Validates the webview JavaScript by simulating template literal rendering
 * and checking syntax with V8. Run after `npm run compile`.
 */
import { readFileSync } from "fs";
import { createScript } from "vm";

const src = readFileSync("dist/extension.js", "utf8");
const scriptMatch = src.match(/<script nonce=[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error("Could not extract script block from dist/extension.js");
  process.exit(1);
}

let script = scriptMatch[1];

// Replace the template interpolation with a mock value
script = script.replace("${initialSummaryJson}", "null");

// Simulate template literal escape processing manually.
// Inside a template literal: \\ → \, \n → newline, \t → tab, \` → `, ${ → ${
// Invalid escapes like \s → s (backslash dropped)
let rendered = script;
// Process recognized double-backslash escapes: \\\\ → \  (in the file, \\\\ is \\)
// Actually, let's just do char-by-char processing
const chars = [];
for (let i = 0; i < script.length; i++) {
  if (script[i] === "\\" && i + 1 < script.length) {
    const next = script[i + 1];
    switch (next) {
      case "\\":
        chars.push("\\");
        i++;
        break; // \\\\ → \
      case "n":
        chars.push("\n");
        i++;
        break; // \\n → newline
      case "r":
        chars.push("\r");
        i++;
        break;
      case "t":
        chars.push("\t");
        i++;
        break;
      case "`":
        chars.push("`");
        i++;
        break;
      case "0":
        chars.push("\0");
        i++;
        break;
      default:
        chars.push(next);
        i++;
        break; // \\s → s (invalid escape, backslash dropped)
    }
  } else {
    chars.push(script[i]);
  }
}
rendered = chars.join("");

try {
  createScript(rendered, { filename: "webview.js" });
  console.log(
    "Webview JS syntax: VALID (%d bytes, %d lines)",
    rendered.length,
    rendered.split("\n").length,
  );
  process.exit(0);
} catch (e) {
  console.error("Webview JS syntax: INVALID -", e.message);
  const match = e.stack.match(/webview\.js:(\d+)/);
  if (match) {
    const lineNum = parseInt(match[1]);
    const lines = rendered.split("\n");
    console.error("Error at line:", lineNum);
    for (
      let i = Math.max(0, lineNum - 4);
      i < Math.min(lines.length, lineNum + 4);
      i++
    ) {
      const marker = i === lineNum - 1 ? ">>>" : "   ";
      console.error(marker, i + 1 + ":", lines[i].substring(0, 200));
    }
  }
  process.exit(1);
}
