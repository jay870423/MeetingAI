export type MeetingTab = "home" | "transcribe" | "todos" | "summary";

export interface LoginResponse {
  token: string;
  username: string;
}

export interface MeetingRecord {
  meeting_id: string;
  file_name: string;
  file_type: string;
  status: string;
  created_at: string;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  timestamp: string;
}

export interface TranscriptPayload {
  meeting_id: string;
  segments: TranscriptSegment[];
  duration: number;
}

export interface TodoItem {
  id?: string;
  content: string;
  assignee?: string | null;
  deadline?: string | null;
  priority?: "high" | "medium" | "low";
  done?: boolean;
  source_excerpt?: string | null;
  source_timestamp?: string | null;
  source_speaker?: string | null;
}

export interface SummaryPayload {
  key_topics: string[];
  decisions: string[];
  action_items: string[];
  attendees: string[];
}
