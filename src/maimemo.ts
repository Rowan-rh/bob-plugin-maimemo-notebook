import { loggedRequest } from "./logger";
const apiEndpoint = "https://open.maimemo.com/open/api/v1";
export const notepadIdFilePath = "$sandbox/notepad-id.txt";

interface MaimemoResponse<T = unknown> {
  success: boolean;
  data?: T;
}

type MaimemoNotepadResponse = MaimemoResponse<{
  notepad?: {
    id: string;
    status: string;
    content: string;
    title: string;
    brief: string;
    tags: string[];
  };
}>;

type MaimemoVocabularyResponse = MaimemoResponse<{
  voc?: {
    id: string;
  };
}>;

function getHeader() {
  const token = $option.maimemoToken!.trim();
  return {
    "Content-Type": "application/json",
    Authorization: token.startsWith("Bearer") ? token : `Bearer ${token}`,
  };
}

/** 把墨墨接口的失败响应整理成可读的原因（HTTP 状态码 + 接口返回的错误信息） */
function describeFailure(action: string, resp: any) {
  const status = resp?.response?.statusCode;
  const data = resp?.data;
  let detail = "";
  if (typeof data === "string") {
    detail = data;
  } else if (data && typeof data === "object") {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    detail = errors.length
      ? errors
          .map((e: any) =>
            typeof e === "string"
              ? e
              : [e?.code, e?.msg || e?.message].filter(Boolean).join(" ") ||
                JSON.stringify(e)
          )
          .join("；")
      : data.message || data.msg || JSON.stringify(data);
  } else if (resp?.error) {
    const error = resp.error as any;
    detail = error.localizedDescription || error.message || JSON.stringify(error);
  } else {
    detail = "接口没有返回内容";
  }

  $log.error(`[墨墨] ${action}失败：HTTP ${status ?? "未知"}，${JSON.stringify(data ?? resp?.error ?? null)}`);
  return `${action}失败（HTTP ${status ?? "未知"}：${String(detail).slice(0, 200)}）`;
}

function getEntryKey(value: string) {
  const firstLine = value.trim().split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^(.+?)\s+\/[^/]+\/(?:\s|$)/);
  return (match?.[1] || firstLine).trim().toLocaleLowerCase();
}

function getEntryLabels(entries: string[]) {
  return entries.map((entry) => getEntryKey(entry));
}

function serializeEntries(entries: string[]) {
  return entries.reduce((content, entry, index) => {
    if (index === 0) {
      return entry.trim();
    }

    const previous = entries[index - 1];
    const separator =
      entry.includes("\n") || previous.includes("\n") ? "\n\n" : "\n";
    return `${content}${separator}${entry.trim()}`;
  }, "");
}

export async function createNotepad(entries: string[]) {
  const header = getHeader();
  const todayDate = new Date().toLocaleDateString("en-CA");

  return loggedRequest<MaimemoNotepadResponse>({
      method: "POST",
      url: `${apiEndpoint}/notepads`,
      header,
      body: {
        notepad: {
          status: "PUBLISHED",
          content: `# ${todayDate}\n${serializeEntries(entries)}\n`,
          title: "Bob Plugin",
          brief: "Bob 插件录入词汇",
          tags: ["词典"],
        },
      },
    })
    .then((_resp) => {
      const resp = _resp.data;
      if (resp?.success && resp.data?.notepad) {
        const notepadId = resp.data.notepad.id;
        $file.write({
          data: $data.fromUTF8(notepadId),
          path: notepadIdFilePath,
        });
        return `云词本创建成功，词条 ${getEntryLabels(entries).join(", ")} 已添加`;
      }

      throw new Error(`${describeFailure("创建云词本", _resp)}，词条未能成功添加`);
    });
}

export async function addWordsToNotepad(notepadId: string, entries: string[]) {
  const header = getHeader();
  const todayDate = new Date().toLocaleDateString("en-CA");

  return loggedRequest<MaimemoNotepadResponse>({
      method: "GET",
      url: `${apiEndpoint}/notepads/${notepadId}`,
      header,
    })
    .then((_resp) => {
      const resp = _resp.data;
      if (!resp?.success || !resp.data?.notepad) {
        throw new Error(
          `${describeFailure(`读取云词本 ${notepadId} `, _resp)}，请检查「墨墨云词本 ID」是否正确`
        );
      }

      const { status, content, title, brief, tags } = resp.data.notepad;
      const lines = content.split("\n").map((line) => line.trim());
      let targetLineIndex = lines.findIndex((line) =>
        line.startsWith(`# ${todayDate}`)
      );

      if (targetLineIndex === -1) {
        lines.unshift("");
        lines.unshift(`# ${todayDate}`);
        targetLineIndex = 0;
      }

      const existingEntries = new Set(
        lines.filter((line) => line && !line.startsWith("#")).map(getEntryKey)
      );
      const uniqueEntries: string[] = [];
      const duplicateEntries: string[] = [];
      for (const entry of entries) {
        const key = getEntryKey(entry);
        if (existingEntries.has(key)) {
          duplicateEntries.push(entry);
        } else {
          uniqueEntries.push(entry);
          existingEntries.add(key);
        }
      }

      const newLines: string[] = [];
      uniqueEntries.forEach((entry, index) => {
        if (
          index > 0 &&
          (entry.includes("\n") || uniqueEntries[index - 1].includes("\n"))
        ) {
          newLines.push("");
        }
        newLines.push(...entry.trim().split(/\r?\n/));
      });
      lines.splice(targetLineIndex + 1, 0, ...newLines);

      return {
        notepad: {
          status,
          content: lines.join("\n"),
          title,
          brief,
          tags,
        },
        uniqueEntries,
        duplicateEntries,
      };
    })
    .then((result) =>
      loggedRequest<MaimemoNotepadResponse>({
          method: "POST",
          url: `${apiEndpoint}/notepads/${notepadId}`,
          header,
          body: { notepad: result.notepad },
        })
        .then((_resp) => {
          if (!_resp.data?.success) {
            throw new Error(describeFailure("保存云词本", _resp));
          }

          const messages: string[] = [];
          if (result.uniqueEntries.length > 0) {
            messages.push(
              `词条 ${getEntryLabels(result.uniqueEntries).join(", ")} 已添加到云词本`
            );
          }
          if (result.duplicateEntries.length > 0) {
            messages.push(
              `${getEntryLabels(result.duplicateEntries).join(", ")} 在云词本中已存在`
            );
          }
          return messages.join("；");
        })
    );
}

export async function findVocabularyId(
  spelling: string
): Promise<string | null> {
  return loggedRequest<MaimemoVocabularyResponse>({
      method: "GET",
      url: `${apiEndpoint}/vocabulary?spelling=${encodeURIComponent(spelling)}`,
      header: getHeader(),
    })
    .then((_resp) => {
      const resp = _resp.data;
      return resp?.success && resp.data?.voc?.id ? resp.data.voc.id : null;
    });
}

export async function addSentenceToWord(
  word: string,
  sentence: string,
  translation: string,
  vocabularyId?: string
) {
  const header = getHeader();
  const vocabularyIdPromise = vocabularyId
    ? Promise.resolve(vocabularyId)
    : findVocabularyId(word);

  return vocabularyIdPromise
    .then((wordId) => {
      if (!wordId) {
        throw new Error(`墨墨词库中没有收录单词 ${word}`);
      }

      return loggedRequest<MaimemoResponse>({
        method: "POST",
        url: `${apiEndpoint}/phrases`,
        header,
        body: {
          phrase: {
            voc_id: wordId,
            phrase: sentence,
            interpretation: translation,
            tags: ["词典"],
            origin: "Bob Plugin",
          },
        },
      });
    })
    .then((_resp) => {
      if (_resp.data?.success) {
        return `例句已添加到单词 ${word}`;
      }
      throw new Error(describeFailure(`添加例句到单词 ${word} `, _resp));
    });
}
