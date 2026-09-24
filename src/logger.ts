/**
 * 调试日志：写入插件沙盒目录下的 maimemo-debug.log，便于排查接口问题。
 * 不记录任何 API Key / Token；过长的内容会被截断，文件超过上限时只保留最近的部分。
 */
export const logFilePath = "$sandbox/maimemo-debug.log";

const MAX_LOG_SIZE = 300000;
const KEEP_LOG_SIZE = 200000;
const MAX_FIELD_LENGTH = 2000;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function summarize(value: unknown) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch (_error) {
    text = String(value);
  }
  if (text === undefined) {
    return "undefined";
  }
  return text.length > MAX_FIELD_LENGTH
    ? `${text.slice(0, MAX_FIELD_LENGTH)}…（共 ${text.length} 字符，已截断）`
    : text;
}

export function writeLog(message: string) {
  const line = `${timestamp()} ${message}\n`;
  try {
    $log.info(message);
  } catch (_error) {
    // ignore
  }
  try {
    let content = $file.exists(logFilePath)
      ? $file.read(logFilePath).toUTF8()
      : "";
    if (content.length > MAX_LOG_SIZE) {
      content = content.slice(-KEEP_LOG_SIZE);
    }
    $file.write({ data: $data.fromUTF8(content + line), path: logFilePath });
  } catch (error) {
    try {
      $log.error(`写入调试日志失败：${error}`);
    } catch (_error) {
      // ignore
    }
  }
}

type RequestOptions = Parameters<typeof $http.request>[0];

/** 带日志的 $http.request：记录请求地址、请求体、HTTP 状态码、耗时和响应内容（不记录请求头） */
export async function loggedRequest<T>(options: RequestOptions) {
  const start = Date.now();
  writeLog(`→ ${options.method} ${options.url}${options.body ? ` 请求体：${summarize(options.body)}` : ""}`);
  try {
    const resp = await $http.request<T>(options);
    const status = resp?.response?.statusCode ?? "未知";
    const payload = resp?.data !== undefined ? resp.data : resp?.error;
    writeLog(`← HTTP ${status}（${Date.now() - start}ms）${options.url} 响应：${summarize(payload)}`);
    return resp;
  } catch (error) {
    writeLog(`✗ 请求异常（${Date.now() - start}ms）${options.url}：${summarize((error as any)?.message ?? error)}`);
    throw error;
  }
}
