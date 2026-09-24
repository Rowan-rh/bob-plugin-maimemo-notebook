const bigModelApiEndpoint =
  "https://open.bigmodel.cn/api/paas/v4/chat/completions";

const miniMaxCNApiEndpoint =
  "https://api.minimaxi.com/v1/text/chatcompletion_v2";

const openaiApiEndpoint = "https://api.openai.com/v1/responses";

interface ChatCompletionResponse {
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string;
    };
  }[];
}

interface OpenAIResponse {
  output_text?: string;
  output?: {
    content?: {
      text?: string;
    }[];
  }[];
}

function getTranslationPrompt() {
  return [
    "你是英语到简体中文的专业翻译。准确理解原文，保留语气和上下文，译文自然通顺。",
    "只输出最终译文，不要解释翻译过程。",
  ].join("\n");
}

function getBearerToken(apiKey: string) {
  return apiKey.trim().startsWith("Bearer ")
    ? apiKey.trim()
    : `Bearer ${apiKey.trim()}`;
}

function getChatCompletionContent(
  raw: ChatCompletionResponse | string | undefined
) {
  let resp: ChatCompletionResponse | undefined;
  if (typeof raw === "string") {
    try {
      resp = JSON.parse(raw);
    } catch (_error) {
      throw new Error(`大模型接口返回了非 JSON 响应：${raw.slice(0, 120)}`);
    }
  } else {
    resp = raw;
  }
  if (!resp) {
    throw new Error("大模型接口没有返回内容，请检查网络或 API Key");
  }

  if (resp.base_resp && resp.base_resp.status_code !== undefined) {
    if (resp.base_resp.status_code !== 0) {
      throw new Error(resp.base_resp.status_msg || "大模型请求失败");
    }
  }

  const choice = resp.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("大模型输出超过长度上限被截断，请减少划选内容后重试");
  }

  // MiniMax M2.x 等推理模型会把思考过程以 <think>...</think> 写在正文里，这里统一去掉
  const content = choice?.message?.content
    ?.replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  if (content && /^<think>/i.test(content)) {
    throw new Error("大模型的思考过程被截断，没有输出结果，请重试");
  }
  if (!content) {
    throw new Error("大模型没有返回文本");
  }

  return content;
}

async function chatByMiniMaxCN(systemPrompt: string, input: string) {
  const apiKey = $option.miniMaxCNApiKey!;
  return $http
    .request<ChatCompletionResponse>({
      method: "POST",
      url: miniMaxCNApiEndpoint,
      header: {
        Authorization: getBearerToken(apiKey),
        "Content-Type": "application/json",
      },
      body: {
        model: $option.miniMaxCNModel || "MiniMax-M3",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        stream: false,
        temperature: 0.2,
        // 推理模型的思考过程也计入该上限，4096 很容易把 JSON 截断
        max_completion_tokens: 16384,
      },
    })
    .then((_resp) => getChatCompletionContent(_resp.data));
}

async function chatByBigModel(systemPrompt: string, input: string) {
  return $http
    .request<ChatCompletionResponse>({
      method: "POST",
      url: bigModelApiEndpoint,
      header: {
        Authorization: $option.bigModelApiKey!,
        "Content-Type": "application/json",
      },
      body: {
        model: $option.bigModelModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
      },
    })
    .then((_resp) => getChatCompletionContent(_resp.data));
}

async function chatByOpenAI(systemPrompt: string, input: string) {
  return $http
    .request<OpenAIResponse>({
      method: "POST",
      url: openaiApiEndpoint,
      header: {
        Authorization: getBearerToken($option.openaiApiKey!),
        "Content-Type": "application/json",
      },
      body: {
        model: $option.openaiModel,
        instructions: systemPrompt,
        input,
        max_output_tokens: 4096,
      },
    })
    .then((_resp) => {
      const resp = _resp.data;
      const content =
        resp.output_text ||
        (resp.output || []).reduce(
          (text, item) =>
            text +
            (item.content || [])
              .map((part) => part.text || "")
              .join(""),
          ""
        );

      if (content?.trim()) {
        return content.trim();
      }

      throw new Error("大模型没有返回文本");
    });
}

export type LLMProvider = "minimax" | "openai" | "bigmodel";

export const providerNames: Record<LLMProvider, string> = {
  minimax: "MiniMax CN",
  openai: "OpenAI",
  bigmodel: "智谱",
};

export function hasProviderKey(provider: LLMProvider) {
  const keys: Record<LLMProvider, string | undefined> = {
    minimax: $option.miniMaxCNApiKey,
    openai: $option.openaiApiKey,
    bigmodel: $option.bigModelApiKey,
  };
  return !!keys[provider]?.trim();
}

/** 使用指定的大模型服务 */
export async function chatWithProvider(
  provider: LLMProvider,
  systemPrompt: string,
  input: string
) {
  if (!hasProviderKey(provider)) {
    throw new Error(`未配置${providerNames[provider]} API Key`);
  }
  switch (provider) {
    case "minimax":
      return chatByMiniMaxCN(systemPrompt, input);
    case "openai":
      return chatByOpenAI(systemPrompt, input);
    case "bigmodel":
      return chatByBigModel(systemPrompt, input);
  }
}

/** 按 MiniMax CN > OpenAI > 智谱 的优先级选择已配置的大模型 */
export async function chatWithLLM(systemPrompt: string, input: string) {
  if ($option.miniMaxCNApiKey) {
    return chatByMiniMaxCN(systemPrompt, input);
  }

  if ($option.openaiApiKey) {
    return chatByOpenAI(systemPrompt, input);
  }

  if ($option.bigModelApiKey) {
    return chatByBigModel(systemPrompt, input);
  }

  throw new Error("未配置大模型 API Key");
}

export async function translateByLLM(sentence: string) {
  return chatWithLLM(getTranslationPrompt(), sentence);
}
