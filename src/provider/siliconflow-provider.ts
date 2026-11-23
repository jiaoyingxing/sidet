import type { ProviderAdapter, ProviderStreamEvent, ProviderStreamInput } from "../types";
import { parseOpenAIStream } from "./stream-parser";

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function toRequestMessages(messages: ProviderStreamInput["messages"]) {
  return messages
    .filter((message) => message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0)
    .map((message) => {
      const attachments = message.attachments ?? [];
      const imageAttachments = attachments.filter((attachment) => attachment.type === "image");
      const textAttachments = attachments.filter((attachment) => attachment.type !== "image");
      const textParts = [
        message.text.trim(),
        ...textAttachments.map((attachment) => attachment.content)
      ].filter((part) => part.trim().length > 0);
      const textContent = textParts.join("\n\n");

      if (imageAttachments.length === 0) {
        return {
          role: message.role,
          content: textContent
        };
      }

      const content: OpenAIContentPart[] = [];
      if (textContent) {
        content.push({
          type: "text",
          text: textContent
        });
      }
      for (const attachment of imageAttachments) {
        content.push({
          type: "image_url",
          image_url: {
            url: attachment.dataUrl
          }
        });
      }

      return {
        role: message.role,
        content
      };
    });
}

function buildRequestBody(input: ProviderStreamInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
    messages: toRequestMessages(input.messages)
  };

  if (input.reasoningCompatibilityMode === "mimo" && input.reasoningMode !== "off") {
    body.chat_template_kwargs = {
      enable_thinking: true
    };
  }

  return body;
}

export class SiliconFlowProvider implements ProviderAdapter {
  async *streamReply(input: ProviderStreamInput): AsyncIterable<ProviderStreamEvent> {
    const endpoint = `${input.baseUrl.replace(/\/+$/g, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(buildRequestBody(input)),
      signal: input.signal
    });

    if (!response.ok) {
      console.error("Sidet：模型服务请求失败", {
        provider: input.modelProviderId,
        status: response.status
      });
      throw new Error(`模型服务请求失败（${response.status}）。请检查 API Key、模型和接口地址。`);
    }

    yield* parseOpenAIStream(response);
  }
}
