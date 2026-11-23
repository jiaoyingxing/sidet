import type { ProviderStreamEvent } from "../types";

function normalizeStreamText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function readChunkEvents(payload: unknown): ProviderStreamEvent[] {
  const choice = (payload as {
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
      message?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
    }>;
  })?.choices?.[0];
  const events: ProviderStreamEvent[] = [];

  const reasoningText = normalizeStreamText(
    choice?.delta?.reasoning_content
      ?? choice?.delta?.reasoning
      ?? choice?.message?.reasoning_content
      ?? choice?.message?.reasoning
  );
  if (reasoningText.length > 0) {
    events.push({
      type: "reasoning",
      text: reasoningText
    });
  }

  const contentText = normalizeStreamText(choice?.delta?.content ?? choice?.message?.content);
  if (contentText.length > 0) {
    events.push({
      type: "content",
      text: contentText
    });
  }

  return events;
}

function consumeBuffer(buffer: string): { events: string[]; rest: string } {
  const chunks = buffer.split(/\r?\n\r?\n/);
  const rest = chunks.pop() ?? "";
  return {
    events: chunks,
    rest
  };
}

export async function* parseOpenAIStream(response: Response): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    throw new Error("接口未返回可读流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    const bufferToConsume = done && buffer.trim().length > 0 ? `${buffer}\n\n` : buffer;
    const { events, rest } = consumeBuffer(bufferToConsume);
    buffer = done ? "" : rest;

    for (const rawEvent of events) {
      const eventText = rawEvent.trim();
      if (!eventText) {
        continue;
      }

      const data = eventText
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(data) as unknown;
      for (const event of readChunkEvents(payload)) {
        if (event.text.length === 0) {
          continue;
        }
        yield event;
      }
    }

    if (done) {
      break;
    }
  }
}
