import { AnalyzedTerm, SentenceAnalysis } from "./types";
import { chatWithLLM } from "./translate";

const analysisPrompt = [
  "你是英语词汇学习助手。分析用户给出的英文句子或短文，返回一个 JSON 对象，不要使用 Markdown 代码块，也不要添加 JSON 以外的文字。",
  "JSON 格式必须是：",
  '{"translation":"整句简体中文翻译","terms":[{"term":"词或短语","kind":"word 或 phrase","ipa":"国际音标，不要加斜线","partOfSpeech":"中文词性","meaning":"简洁中文释义","formAndSound":"词形变化说明与读音联想","etymology":"可靠词源；不确定时留空","codePath":"概念性的代码模块/包路径","className":"类名","classResponsibility":"该类的职责","contrast":"概念A vs 概念B","image":"帮助记忆的画面感比喻","homophone":"中文谐音助记"}]}',
  "提取句中值得学习的内容词、固定搭配、动词短语和习语；不要收录冠词、介词等普通功能词。尽量保留原文词形，重复词条去重，按对理解句子的价值排序，最多返回 8 个。",
  "每个词条都必须有 IPA、词性、中文释义、词形与读音联想、代码场景、概念对比、画面比喻和谐音助记。短语的词性可写‘短语’或具体搭配类型。",
  "词源只在你有把握时提供，不确定时将 etymology 设为空字符串；不要编造词源、神话或历史事实。",
  "代码场景是帮助记忆的虚构类比，不是对用户真实代码库的描述。请给出类似 src/cache/ttl.ts 的概念路径、一个类名和一句职责说明。",
  "translation 必须是原文的完整简体中文翻译；如果输入还包含用户指定词条，不能把词条清单翻译进 translation。",
  "输出必须是可被 JSON.parse 直接解析的合法 JSON：字符串值内部禁止出现英文双引号和换行，需要引用时使用「」；JSON 之后不要输出任何内容。",
].join("\n");

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function requiredSingleLine(
  record: Record<string, unknown>,
  key: string,
  label: string
) {
  const value = getString(record, key).replace(/[\r\n]+/g, " ").trim();
  if (!value) {
    throw new Error(`大模型返回的词条缺少${label}`);
  }
  return value;
}

function parseTerm(value: unknown): AnalyzedTerm | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    return parseTermRecord(value as Record<string, unknown>);
  } catch (error) {
    $log.error(`跳过不完整的词条：${JSON.stringify(value)}；${error}`);
    return null;
  }
}

function parseTermRecord(record: Record<string, unknown>): AnalyzedTerm {

  const rawKind = getString(record, "kind");
  const etymology = getString(record, "etymology").replace(/[\r\n]+/g, " ");

  return {
    term: requiredSingleLine(record, "term", "词或短语"),
    kind: /phrase|短语|词组|搭配/i.test(rawKind) ? "phrase" : "word",
    ipa: requiredSingleLine(record, "ipa", "音标"),
    partOfSpeech: requiredSingleLine(record, "partOfSpeech", "词性"),
    meaning: requiredSingleLine(record, "meaning", "中文释义"),
    formAndSound: requiredSingleLine(record, "formAndSound", "词形和读音联想"),
    etymology,
    codePath: requiredSingleLine(record, "codePath", "代码场景路径"),
    className: requiredSingleLine(record, "className", "代码场景类名"),
    classResponsibility: requiredSingleLine(
      record,
      "classResponsibility",
      "代码场景职责"
    ),
    contrast: requiredSingleLine(record, "contrast", "概念对比"),
    image: requiredSingleLine(record, "image", "画面比喻"),
    homophone: requiredSingleLine(record, "homophone", "谐音助记"),
  };
}

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
    throw new Error("大模型没有返回有效的句子分析 JSON");
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

function parseAnalysis(response: string): SentenceAnalysis {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(response));
  } catch (error) {
    $log.error(`句子分析解析失败，模型原始输出：${response}`);
    if (error instanceof SyntaxError) {
      throw new Error("大模型返回的句子分析不是合法 JSON，请重试");
    }
    throw error;
  }

  const translation = getString(parsed, "translation");
  const rawTerms = parsed.terms;
  if (!translation || !Array.isArray(rawTerms)) {
    throw new Error("大模型返回的句子分析缺少译文或词条列表");
  }

  const seen = new Set<string>();
  const terms = rawTerms
    .slice(0, 8)
    .map(parseTerm)
    .filter((term): term is AnalyzedTerm => {
      if (!term) {
        return false;
      }
      const key = term.term.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return { translation, terms };
}

export async function analyzeSentence(text: string, preferredTerms: string[] = []) {
  const input = preferredTerms.length
    ? `待分析的英文原句：\n${text}\n\n用户特别指定要整理的词/短语：${preferredTerms.join(", ")}。请将它们纳入 terms。`
    : "";
  const userInput = input || text;
  const response = await chatWithLLM(analysisPrompt, userInput);
  try {
    return parseAnalysis(response);
  } catch (_error) {
    // 模型偶尔输出不合法的 JSON，重试一次并强调格式要求
    const retry = await chatWithLLM(
      analysisPrompt,
      `${userInput}\n\n（注意：只输出一个合法 JSON 对象，字符串内不要使用英文双引号。）`
    );
    return parseAnalysis(retry);
  }
}

export function formatCustomTerm(term: AnalyzedTerm) {
  const ipa = term.ipa.replace(/^\/+|\/+$/g, "");
  const lines = [
    `${term.term} /${ipa}/ ${term.partOfSpeech} ${term.meaning}`,
    `【词形】${term.formAndSound}`,
  ];

  if (term.etymology) {
    lines.push(`【词源】${term.etymology}`);
  }

  lines.push(
    `【场景】代码定位 ${term.codePath}：`,
    `▸ ${term.className} ${term.classResponsibility}`,
    `【对比】${term.contrast}`,
    `【画面】${term.image}`,
    `谐音 ${term.homophone}`
  );

  return lines.join("\n");
}
