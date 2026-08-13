/**
 * Minimal client for the bits of the Ollama HTTP API this plugin drives
 * directly: listing locally-present models and streaming a `pull`. Not a
 * general Ollama client — callers of the LLM itself (chat/generate/embed)
 * are the sibling services this plugin exists to feed, not this plugin.
 */

import { errMsg } from "signalk-container-helper";

export interface OllamaTag {
  name: string;
}

export interface PullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** "llama3.2" and "llama3.2:latest" name the same pulled model. */
export function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** Model names Ollama already has pulled, normalized. Throws on transport/HTTP errors. */
export async function listLocalModels(baseUrl: string): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) {
    throw new Error(`GET /api/tags failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { models?: OllamaTag[] };
  const names = new Set<string>();
  for (const model of body.models ?? []) {
    if (typeof model.name === "string") names.add(model.name);
  }
  return names;
}

/**
 * Stream a `POST /api/pull`, invoking `onProgress` for each NDJSON line.
 * Resolves once Ollama reports the final "success" status; rejects on a
 * transport error, non-2xx response, or an `{error}` line in the stream —
 * Ollama reports failures (unknown model, disk full, registry unreachable)
 * inside a 200 response body rather than as an HTTP status.
 */
export async function pullModel(
  baseUrl: string,
  model: string,
  onProgress: (event: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });
  } catch (err) {
    throw new Error(`pull request for ${model} failed: ${errMsg(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new Error(`pull request for ${model} failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error(`pull request for ${model} returned no response body`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawSuccess = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const event = JSON.parse(line) as PullEvent;
      if (event.error) throw new Error(event.error);
      if (event.status === "success") sawSuccess = true;
      onProgress(event);
    }
  }
  if (!sawSuccess) {
    throw new Error(`pull stream for ${model} ended without a success status`);
  }
}

/** Remove a locally-pulled model. */
export async function deleteModel(
  baseUrl: string,
  model: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model }),
  });
  if (!res.ok) {
    throw new Error(`delete of ${model} failed: HTTP ${res.status}`);
  }
}
