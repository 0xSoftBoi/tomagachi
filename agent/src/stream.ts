/**
 * Counting tokens out of an SSE stream, without getting in the stream's way.
 *
 * Bytes are forwarded to the caller untouched and the same bytes are tallied
 * here, so billing never delays a token. The awkward part is that chunk
 * boundaries fall wherever TCP decides: a frame can arrive in halves, and the
 * half-frame must be held rather than parsed, or a completion gets billed at
 * zero. That is the whole reason this is a class with a buffer and not a
 * function over a chunk.
 */

export interface StreamTally {
  /** Reported by the upstream usage frame; 0 means it never sent one. */
  promptTokens: number;
  completionTokens: number;
  /** Characters seen in deltas — the fallback when there is no usage frame. */
  completionChars: number;
  sawDone: boolean;
}

export class SseTally {
  private buffered = "";
  readonly tally: StreamTally = {
    promptTokens: 0,
    completionTokens: 0,
    completionChars: 0,
    sawDone: false,
  };

  /** Feed a decoded chunk. Safe to call with partial frames. */
  push(chunk: string): void {
    this.buffered += chunk;
    const lines = this.buffered.split("\n");
    // The last element is either "" (chunk ended on a newline) or a partial
    // line. Either way it is not ready, so it goes back in the buffer.
    this.buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        this.tally.sawDone = true;
        continue;
      }
      let frame: any;
      try {
        frame = JSON.parse(data);
      } catch {
        continue; // not valid JSON on its own; nothing to count
      }
      if (frame.usage) {
        this.tally.promptTokens = frame.usage.prompt_tokens ?? this.tally.promptTokens;
        this.tally.completionTokens = frame.usage.completion_tokens ?? this.tally.completionTokens;
      }
      for (const choice of frame.choices ?? []) {
        this.tally.completionChars += (choice.delta?.content ?? "").length;
      }
    }
  }
}
