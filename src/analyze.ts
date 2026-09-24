import { chatWithProvider, LLMProvider } from "./translate";

const MAX_TERMS = 8;

const extractPrompt = [
  "你是英语词汇提取助手。从用户给出的英文内容中，提取值得学习的单词和短语（固定搭配、动词短语、习语）。",
  "不要翻译，不要解释，不要分析。只输出一个 JSON 对象，格式为：{\"terms\":[\"word\",\"phrase\"]}",
  "单词使用词典原形（动词原形、名词单数）；短语使用常见的词典形式。",
  "不要收录冠词、介词、代词等普通功能词，也不要收录人名、地名等专有名词。",
  `重复项去重，按学习价值排序，最多返回 ${MAX_TERMS} 个。没有值得学习的词时返回 {"terms":[]}。`,
  "不要使用 Markdown 代码块，JSON 之后不要输出任何内容。",
].join("\n");

/** 从模型输出里取出第一个完整的 JSON 对象（忽略思考过程、代码块和前后说明文字） */
function extractJsonObject(response: string) {
  let text = response;
  const thinkEnd = text.toLowerCase().lastIndexOf("</think>");
  if (thinkEnd >= 0) {
    text = text.slice(thinkEnd + "</think>".length);
  } else if (/<think>/i.test(text)) {
    throw new Error("大模型的思考过程被截断，没有输出结果，请重试");
  }
  text = text.replace(/```(?:json)?/gi, "");

  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("大模型没有返回有效的词条 JSON");
  }

  // 按括号配对找到对象结尾，JSON 后面再跟说明文字时也能正确截取
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  throw new Error("大模型返回的 JSON 不完整（可能被截断），请重试");
}

function parseTerms(response: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(response));
  } catch (error) {
    $log.error(`词条提取解析失败，模型原始输出：${response}`);
    if (error instanceof SyntaxError) {
      throw new Error("大模型返回的词条不是合法 JSON，请重试");
    }
    throw error;
  }

  const rawTerms = (parsed as { terms?: unknown })?.terms;
  if (!Array.isArray(rawTerms)) {
    throw new Error("大模型返回的结果缺少词条列表");
  }

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of rawTerms) {
    // 兼容模型偶尔返回 {"term": "..."} 对象的情况
    const value =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof item.term === "string"
        ? item.term
        : "";
    const term = value.replace(/\s+/g, " ").trim();
    const key = term.toLocaleLowerCase();
    if (term && !seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  return terms.slice(0, MAX_TERMS);
}

/** 让大模型从英文内容中拆出单词和短语，只返回词条列表 */
export async function extractTerms(text: string, provider: LLMProvider) {
  const response = await chatWithProvider(provider, extractPrompt, text);
  try {
    return parseTerms(response);
  } catch (_error) {
    // 模型偶尔输出不合法的 JSON，重试一次
    const retry = await chatWithProvider(
      provider,
      extractPrompt,
      `${text}\n\n（注意：只输出一个合法 JSON 对象。）`
    );
    return parseTerms(retry);
  }
}
