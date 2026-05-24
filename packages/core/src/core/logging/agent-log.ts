import type { ProjectSnapshot } from "../../types/project";

export const AGENT_LOG_PATH = ".novel/logs/agent.log.jsonl";

export type AgentLogLevel = "debug" | "info" | "warn" | "error";

export type AgentLogEntry = {
  id: string;
  time: string;
  timeUtc: string;
  timezone: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  level: AgentLogLevel;
  event: string;
  message: string;
  data?: unknown;
};

export type AgentLogInput = Omit<AgentLogEntry, 'id' | 'time' | 'timeUtc' | 'timezone' | 'projectId'>

const MAX_STRING_LENGTH = 1200;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 40;
const logWriteQueues = new Map<string, Promise<void>>();

export function createLogId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeAgentLog(
  project: ProjectSnapshot,
  input: AgentLogInput,
) {
  const now = new Date();
  const entry: AgentLogEntry = {
    id: createLogId("log"),
    time: formatLocalIsoWithOffset(now),
    timeUtc: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    projectId: project.id,
    ...input,
    data: sanitizeLogData(input.data),
  };

  const previousWrite = logWriteQueues.get(project.id) ?? Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(() =>
      appendText(project.handle, AGENT_LOG_PATH, `${JSON.stringify(entry)}\n`),
    )
    .catch((error) => {
      console.warn("写入 Agent 日志失败", error);
    });

  logWriteQueues.set(project.id, nextWrite);
  await nextWrite;
}

function sanitizeLogData(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[MaxDepth]";
  }

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeLogData(item, depth + 1));

    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[truncated ${value.length - MAX_ARRAY_LENGTH} items]`);
    }

    return items;
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );

    for (const [key, item] of entries) {
      output[key] = isSensitiveKey(key)
        ? "[redacted]"
        : sanitizeLogData(item, depth + 1);
    }

    const keyCount = Object.keys(value as Record<string, unknown>).length;

    if (keyCount > MAX_OBJECT_KEYS) {
      output.__truncatedKeys = keyCount - MAX_OBJECT_KEYS;
    }

    return output;
  }

  return String(value);
}

function isSensitiveKey(key: string) {
  return /api[-_]?key|authorization|token|secret|password/i.test(key);
}

function formatLocalIsoWithOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");

  return [
    date.getFullYear(),
    "-",
    String(date.getMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getDate()).padStart(2, "0"),
    "T",
    String(date.getHours()).padStart(2, "0"),
    ":",
    String(date.getMinutes()).padStart(2, "0"),
    ":",
    String(date.getSeconds()).padStart(2, "0"),
    ".",
    String(date.getMilliseconds()).padStart(3, "0"),
    sign,
    hours,
    ":",
    minutes,
  ].join("");
}

async function appendText(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
  content: string,
) {
  const fileHandle = await ensureFileHandle(rootHandle, path);
  const file = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });

  await writable.seek(file.size);
  await writable.write(content);
  await writable.close();
}

async function ensureFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
) {
  const segments = path.split("/").filter(Boolean);
  const fileName = segments.pop();

  if (!fileName) {
    throw new Error(`Invalid log file path: ${path}`);
  }

  let current = rootHandle;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }

  return current.getFileHandle(fileName, { create: true });
}
