import {
  createNotepad,
  addSentenceToWord,
  addWordsToNotepad,
  notepadIdFilePath,
} from "./maimemo";
import { extractTerms } from "./analyze";
import {
  hasProviderKey,
  LLMProvider,
  providerNames,
  translateByLLM,
} from "./translate";
import { BobQuery, BobTranslationErrorType } from "./types";

export function supportLanguages() {
  return ["zh-Hans", "en"];
}

async function addEntriesToNotepad(entries: string[], configuredNotepadId?: string) {
  let notepadId = configuredNotepadId;
  if (!notepadId && $file.exists(notepadIdFilePath)) {
    notepadId = $file.read(notepadIdFilePath).toUTF8();
  }

  return notepadId
    ? addWordsToNotepad(notepadId, entries)
    : createNotepad(entries);
}

function getExtractProvider(): LLMProvider | null {
  const value = $option.extractProvider || "minimax";
  return value === "minimax" || value === "openai" || value === "bigmodel"
    ? value
    : null;
}

async function extractAndAddTerms(
  text: string,
  provider: LLMProvider,
  configuredNotepadId?: string
) {
  const terms = await extractTerms(text.trim(), provider);
  if (terms.length === 0) {
    throw new Error("AI 没有提取到可加入词本的单词或短语");
  }
  const notepadMessage = await addEntriesToNotepad(terms, configuredNotepadId);
  return `AI 提取了 ${terms.length} 个词条：${notepadMessage}`;
}

export function translate(query: BobQuery) {
  const { text, detectFrom, onCompletion } = query;
  const {
    maimemoToken,
    notepadId: _notepadId,
    canAddSentence: _canAddSentence,
    bigModelApiKey,
    openaiApiKey,
    miniMaxCNApiKey,
  } = $option;
  const extractProvider = getExtractProvider();

  if (detectFrom !== "en") {
    onCompletion({
      error: {
        type: BobTranslationErrorType.UnSupportedLanguage,
        message: "墨墨云词本只支持添加英文单词",
      },
    });
    return;
  }

  const wordNum = text.trim().split(/\s+/);
  const maybeSentence = wordNum.length > 2;
  const canAddSentence = _canAddSentence === "true";
  const lineCount = text.split("\n").filter((line) => !!line.trim()).length;
  // 例句模式下「第一行词条 + 第二行例句」是用户手动指定的格式，走原有流程
  const hasManualTermList = canAddSentence && lineCount > 1;

  // 开启 AI 提取时，句子/段落交给所选大模型拆出单词和短语；单个单词直接走原有流程
  if (extractProvider && maybeSentence && !hasManualTermList) {
    if (!hasProviderKey(extractProvider)) {
      onCompletion({
        error: {
          type: BobTranslationErrorType.NoSecretKey,
          message: `已选择用${providerNames[extractProvider]}提取词条，但未配置它的 API Key`,
        },
      });
      return;
    }
    if (!maimemoToken) {
      onCompletion({
        error: {
          type: BobTranslationErrorType.NoSecretKey,
          message: "墨墨开放 API Token 未配置",
        },
      });
      return;
    }

    extractAndAddTerms(text, extractProvider, _notepadId)
      .then((message) => {
        onCompletion({ result: { toParagraphs: [message] } });
      })
      .catch((error) => {
        onCompletion({
          error: {
            type: BobTranslationErrorType.Network,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return;
  }

  if (maybeSentence && !canAddSentence) {
    onCompletion({
      error: {
        type: BobTranslationErrorType.NotFound,
        message: "未检测到单词",
      },
    });
    return;
  }

  const paragraphs = text.split("\n").filter((line) => !!line.trim());
  const words = paragraphs[0]
    .split(",")
    .map((word) => word.trim())
    .filter((word) => !!word && word.split(/\s+/).length < 3);
  const sentence = paragraphs[1]?.trim?.() || "";
  let notepadId = _notepadId;

  if (!maimemoToken) {
    onCompletion({
      error: {
        type: BobTranslationErrorType.NoSecretKey,
        message: "墨墨开放 API Token 未配置",
      },
    });
    return;
  }

  if (words.length === 0) {
    onCompletion({
      error: {
        type: BobTranslationErrorType.NotFound,
        message: "未检测到单词",
      },
    });
    return;
  }

  // Create sample sentence for words
  let finished = false;
  let partMessage = "";
  if (canAddSentence) {
    if (!sentence) {
      partMessage = "例句创建失败（未检测到例句）";
      finished = true;
    } else if (!bigModelApiKey && !openaiApiKey && !miniMaxCNApiKey) {
      partMessage = "例句创建失败（未配置大模型 API Key）";
      finished = true;
    } else {
      translateByLLM(sentence)
        .then((translation) => {
          const tasks = words.map((word) =>
            addSentenceToWord(word, sentence, translation)
          );
          Promise.allSettled(tasks).then((results) => {
            const hasAnySuccess = results.some(
              (task) => task.status === "fulfilled"
            );

            if (finished) {
              if (hasAnySuccess) {
                onCompletion({
                  result: {
                    toParagraphs: [
                      `${partMessage ? partMessage + "，" : ""}例句创建成功`,
                    ],
                  },
                });
              } else {
                const failReason = results.find(
                  (task) => task.status === "rejected"
                )?.reason;

                onCompletion({
                  error: {
                    type: BobTranslationErrorType.Network,
                    message: `${
                      partMessage ? partMessage + "，" : ""
                    }例句创建失败（${failReason}）`,
                  },
                });
              }
            } else {
              partMessage = `例句创建${hasAnySuccess ? "成功" : "失败"}`;
              finished = true;
            }
          });
        })
        .catch((error) => {
          const currentPartMessage = `例句创建失败（${error.message}）`;
          if (finished) {
            onCompletion({
              error: {
                type: BobTranslationErrorType.Network,
                message: `${
                  partMessage ? partMessage + "，" : ""
                }${currentPartMessage}`,
              },
            });
          } else {
            partMessage = currentPartMessage;
            finished = true;
          }
        });
    }
  } else {
    finished = true;
  }

  // Try to grab cached notepadId if user don't provide one
  if (!notepadId && $file.exists(notepadIdFilePath)) {
    notepadId = $file.read(notepadIdFilePath).toUTF8();
  }

  let addWordsTask = null;
  if (notepadId) {
    // Add words to existing notepad
    addWordsTask = addWordsToNotepad(notepadId, words);
  } else {
    // Create new notepad
    addWordsTask = createNotepad(words);
  }

  addWordsTask
    .then((result) => {
      if (finished) {
        onCompletion({
          result: {
            toParagraphs: [`${result}${partMessage ? "，" + partMessage : ""}`],
          },
        });
      } else {
        partMessage = result;
      }
    })
    .catch((error) => {
      if (finished) {
        onCompletion({
          error: {
            type: BobTranslationErrorType.Network,
            message: `${error.message}${partMessage ? "，" + partMessage : ""}`,
          },
        });
      } else {
        partMessage = error.message;
      }
    })
    .finally(() => {
      finished = true;
    });
}
