import type {
  LoginResponse,
  MeetingRecord,
  SummaryPayload,
  TodoItem,
  TranscriptPayload,
} from "../types";

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data?: T;
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

export async function extractTodos(meetingId: string): Promise<{ todos: TodoItem[] }> {
  return request<{ todos: TodoItem[] }>(`/meetings/${meetingId}/todos`, {
    method: "POST",
  });
}

export async function generateSummary(meetingId: string): Promise<{ summary: SummaryPayload }> {
  return request<{ summary: SummaryPayload }>(`/meetings/${meetingId}/summary`, {
    method: "POST",
  });
}
