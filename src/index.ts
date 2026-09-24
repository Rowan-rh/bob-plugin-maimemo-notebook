import {
  createNotepad,
  addSentenceToWord,
  addWordsToNotepad,
  findVocabularyId,
  notepadIdFilePath,
} from "./maimemo";
import { analyzeSentence, formatCustomTerm } from "./analyze";
import { translateByLLM } from "./translate";
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

async function analyzeAndAddSentence(
  text: string,
  configuredNotepadId: string | undefined,
  canAddSentence: boolean
) {
  const paragraphs = text
    .split(/\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const hasManualTermList = canAddSentence && paragraphs.length > 1;
  const sentence = hasManualTermList
    ? paragraphs.slice(1).join("\n")
    : text.trim();
  const preferredTerms = hasManualTermList
    ? paragraphs[0]
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean)
    : [];
  const analysis = await analyzeSentence(sentence, preferredTerms);
  if (analysis.terms.length === 0) {
    throw new Error("AI 没有识别出可加入词本的单词或短语");
  }

  const classifiedTerms = await Promise.all(
    analysis.terms.map(async (term) => {
      const vocabularyId = await findVocabularyId(term.term);
      return {
        term,
        vocabularyId,
        entry: vocabularyId ? term.term : formatCustomTerm(term),
      };
    })
  );

  const notepadMessage = await addEntriesToNotepad(
    classifiedTerms.map(({ entry }) => entry),
    configuredNotepadId
  );

  let exampleMessage = "";
  if (canAddSentence) {
    const knownWords = classifiedTerms.filter(
      ({ term, vocabularyId }) => vocabularyId && term.kind === "word"
    );
    if (knownWords.length > 0) {
      const exampleResults = await Promise.allSettled(
        knownWords.map(({ term, vocabularyId }) =>
          addSentenceToWord(
            term.term,
            sentence,
            analysis.translation,
            vocabularyId!
          )
        )
      );
      const successCount = exampleResults.filter(
        (result) => result.status === "fulfilled"
      ).length;
      const failureCount = exampleResults.length - successCount;
      if (successCount > 0) {
        exampleMessage = `，例句已添加到 ${successCount} 个墨墨词条`;
      }
      if (failureCount > 0) {
        exampleMessage += `，${failureCount} 个例句添加失败`;
      }
    }
  }

  const knownCount = classifiedTerms.filter(
    ({ vocabularyId }) => !!vocabularyId
  ).length;
  const customCount = classifiedTerms.length - knownCount;
  return `AI 分析完成：墨墨已收录 ${knownCount} 项，自定义词条 ${customCount} 项。${notepadMessage}${exampleMessage}`;
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

  if (text.trim() && miniMaxCNApiKey) {
    if (!maimemoToken) {
      onCompletion({
        error: {
          type: BobTranslationErrorType.NoSecretKey,
          message: "墨墨开放 API Token 未配置",
        },
      });
      return;
    }

    analyzeAndAddSentence(text, _notepadId, canAddSentence)
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
