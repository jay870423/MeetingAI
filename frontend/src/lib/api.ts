import type {
  LoginResponse,
  MeetingRecord,
  SummaryPayload,
  TodoItem,
  TranscriptPayload,
  TranscriptSegment,
} from "../types";

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data?: T;
}

interface TranscriptStreamStatusPayload {
  message: string;
}

interface TranscriptStreamSegmentPayload {
  meeting_id: string;
  segment: TranscriptSegment;
  count: number;
  duration: number;
}

interface TranscriptStreamCallbacks {
  onComplete?: (payload: TranscriptPayload) => void;
  onError?: (payload: { message: string }) => void;
  onSegment?: (payload: TranscriptStreamSegmentPayload) => void;
  onStatus?: (payload: TranscriptStreamStatusPayload) => void;
}

interface TodoStreamStatusPayload {
  message: string;
}

interface TodoStreamItemPayload {
  meeting_id: string;
  todo: TodoItem;
  count: number;
  total: number;
}

interface TodoStreamCompletePayload {
  todos: TodoItem[];
}

interface TodoStreamCallbacks {
  onComplete?: (payload: TodoStreamCompletePayload) => void;
  onError?: (payload: { message: string }) => void;
  onItem?: (payload: TodoStreamItemPayload) => void;
  onStatus?: (payload: TodoStreamStatusPayload) => void;
}

const buildDefaultBaseUrl = () => {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:8989/api/v1";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8989/api/v1`;
};

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || buildDefaultBaseUrl();

const TOKEN_KEY = "meetingai_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export const setToken = (token: string) => {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
};

const buildHeaders = (extra: HeadersInit = {}) => {
  const token = getToken();
  const headers = new Headers(extra);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
};

async function parseResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  let payload: ApiEnvelope<T> | T;
  try {
    payload = JSON.parse(rawText) as ApiEnvelope<T> | T;
  } catch {
    throw new Error(rawText || "服务返回了无法解析的响应");
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "code" in payload &&
    typeof (payload as ApiEnvelope<T>).code === "number"
  ) {
    const envelope = payload as ApiEnvelope<T>;
    if (envelope.code !== 0 && envelope.code !== 200) {
      throw new Error(envelope.message || "请求失败");
    }
    return (envelope.data ?? (payload as T)) as T;
  }

  if (!response.ok) {
    throw new Error("请求失败");
  }

  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: buildHeaders(init?.headers),
  });
  return parseResponse<T>(response);
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function uploadMeeting(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<MeetingRecord> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);
    xhr.open("POST", `${API_BASE_URL}/meetings/upload`);
    const token = getToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("网络异常，上传失败"));
    xhr.onload = async () => {
      try {
        const response = new Response(xhr.responseText, { status: xhr.status });
        const result = await parseResponse<MeetingRecord>(response);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(formData);
  });
}

export async function transcribeMeeting(meetingId: string): Promise<TranscriptPayload> {
  return request<TranscriptPayload>(`/meetings/${meetingId}/transcribe`, {
    method: "POST",
  });
}

export async function transcribeMeetingStream(
  meetingId: string,
  callbacks: TranscriptStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/meetings/${meetingId}/transcribe/stream`, {
    method: "POST",
    headers: buildHeaders({ Accept: "text/event-stream" }),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    await parseResponse<TranscriptPayload>(response);
    return;
  }

  if (!response.body) {
    throw new Error("服务未返回可读取的转写流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const dispatchEvent = (eventName: string, payload: unknown) => {
    if (eventName === "status") {
      callbacks.onStatus?.(payload as TranscriptStreamStatusPayload);
      return;
    }
    if (eventName === "segment") {
      callbacks.onSegment?.(payload as TranscriptStreamSegmentPayload);
      return;
    }
    if (eventName === "complete") {
      callbacks.onComplete?.(payload as TranscriptPayload);
      return;
    }
    if (eventName === "error") {
      callbacks.onError?.(payload as { message: string });
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message: string }).message)
          : "转写失败";
      throw new Error(message);
    }
  };

  const consumeBuffer = () => {
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      const payload = JSON.parse(dataLines.join("\n"));
      dispatchEvent(eventName, payload);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    consumeBuffer();
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    consumeBuffer();
  }
}

export async function extractTodos(meetingId: string): Promise<{ todos: TodoItem[] }> {
  return request<{ todos: TodoItem[] }>(`/meetings/${meetingId}/todos`, {
    method: "POST",
  });
}

export async function extractTodosStream(
  meetingId: string,
  callbacks: TodoStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/meetings/${meetingId}/todos/stream`, {
    method: "POST",
    headers: buildHeaders({ Accept: "text/event-stream" }),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    await parseResponse<{ todos: TodoItem[] }>(response);
    return;
  }

  if (!response.body) {
    throw new Error("服务未返回可读取的待办提取流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const dispatchEvent = (eventName: string, payload: unknown) => {
    if (eventName === "status") {
      callbacks.onStatus?.(payload as TodoStreamStatusPayload);
      return;
    }
    if (eventName === "item") {
      callbacks.onItem?.(payload as TodoStreamItemPayload);
      return;
    }
    if (eventName === "complete") {
      callbacks.onComplete?.(payload as TodoStreamCompletePayload);
      return;
    }
    if (eventName === "error") {
      callbacks.onError?.(payload as { message: string });
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message: string }).message)
          : "待办提取失败";
      throw new Error(message);
    }
  };

  const consumeBuffer = () => {
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      const payload = JSON.parse(dataLines.join("\n"));
      dispatchEvent(eventName, payload);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    consumeBuffer();
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    consumeBuffer();
  }
}

export async function generateSummary(meetingId: string): Promise<{ summary: SummaryPayload }> {
  return request<{ summary: SummaryPayload }>(`/meetings/${meetingId}/summary`, {
    method: "POST",
  });
}
