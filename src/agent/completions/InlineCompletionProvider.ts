/**
 * InlineCompletionProvider — Ghost-text (autocomplete) powered by Ollama's
 * /api/generate endpoint with fill-in-middle (FIM) support.
 *
 * This gives Pulse Copilot-like inline code suggestions while typing.
 */
import * as vscode from "vscode";

const DEFAULT_DEBOUNCE_MS = 350;
const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1000;
const GENERATE_TIMEOUT_MS = 8000;

export class InlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private pending: AbortController | null = null;

  constructor(
    private readonly ollamaBaseUrl: string,
    private readonly model: string,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    // Cancel any in-flight request
    if (this.pending) {
      this.pending.abort();
      this.pending = null;
    }

    // Don't complete in output/terminal/non-file schemes
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
      return null;
    }

    // Simple debounce: wait before actually requesting
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DEFAULT_DEBOUNCE_MS),
    );
    if (token.isCancellationRequested) return null;

    const textBefore = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    );
    const textAfter = document.getText(
      new vscode.Range(
        position,
        document.lineAt(document.lineCount - 1).range.end,
      ),
    );

    const prefix = textBefore.slice(-MAX_PREFIX_CHARS);
    const suffix = textAfter.slice(0, MAX_SUFFIX_CHARS);

    // Skip if prefix is too short
    if (prefix.trim().length < 5) return null;

    const controller = new AbortController();
    this.pending = controller;

    token.onCancellationRequested(() => controller.abort());

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        prompt: prefix,
        suffix,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 128,
          stop: ["\n\n", "\r\n\r\n"],
        },
      };

      const response = await fetch(`${this.ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        ]),
      });

      if (!response.ok) return null;

      const json = (await response.json()) as { response?: string };
      const completionText = json.response?.trim();

      if (!completionText) return null;

      const item = new vscode.InlineCompletionItem(
        completionText,
        new vscode.Range(position, position),
      );

      return [item];
    } catch {
      // Aborted, timed out, or Ollama not running — silently return nothing
      return null;
    } finally {
      if (this.pending === controller) {
        this.pending = null;
      }
    }
  }
}
