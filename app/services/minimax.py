from __future__ import annotations

import json
import mimetypes
import os
import re
from threading import Lock
from typing import Any, Iterator

import httpx

from app.core.config import settings


class MiniMaxService:
    """MiniMax 文本能力 + 本地/远程 ASR 转写服务。"""

    _local_asr_model: Any = None
    _local_asr_signature: tuple[str, str, str] | None = None
    _local_asr_lock = Lock()

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or settings.minimax_api_key
        self.endpoint = settings.minimax_endpoint
        self.asr_endpoint = settings.minimax_asr_endpoint
        self.model = settings.minimax_model
        self.asr_model = settings.minimax_asr_model

    def _authorization_headers(self) -> dict[str, str]:
        if not self.api_key:
            raise ValueError("MiniMax API Key 未配置")
        return {"Authorization": f"Bearer {self.api_key}"}

    def _json_headers(self) -> dict[str, str]:
        headers = self._authorization_headers()
        headers["Content-Type"] = "application/json"
        return headers

    def chat(self, prompt: str, system: str = "你是专业的 AI 会议助手。") -> str:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.3,
            "max_tokens": 4096,
        }

        with httpx.Client(timeout=60.0) as client:
            response = client.post(self.endpoint, json=payload, headers=self._json_headers())
            response.raise_for_status()
            result = response.json()
            return result["choices"][0]["message"]["content"]

    def _is_valid_json(self, text: str) -> bool:
        try:
            json.loads(text)
            return True
        except (json.JSONDecodeError, ValueError):
            return False

    def _extract_json(self, text: str) -> Any:
        try:
            return json.loads(text.strip())
        except (json.JSONDecodeError, ValueError):
            pass

        for pattern in [r"```json\s*([\s\S]+?)\s*```", r"```\s*([\s\S]+?)\s*```"]:
            match = re.search(pattern, text)
            if not match:
                continue
            candidate = match.group(1).strip()
            if self._is_valid_json(candidate):
                return json.loads(candidate)

        starts = [match.start() for match in re.finditer(r"\{", text)]
        for start in reversed(starts):
            candidate = text[start:]
            if self._is_valid_json(candidate):
                return json.loads(candidate)

        depth = 0
        start_idx = -1
        in_string = False
        escape_next = False
        for index, char in enumerate(text):
            if escape_next:
                escape_next = False
                continue
            if char == "\\":
                escape_next = True
                continue
            if char == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue
            if char == "{":
                if start_idx == -1:
                    start_idx = index
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0 and start_idx != -1:
                    candidate = text[start_idx : index + 1]
                    if self._is_valid_json(candidate):
                        return json.loads(candidate)

        raise ValueError(f"无法从响应中提取 JSON: {text[:200]}")

    def transcribe_audio(self, file_path: str) -> dict[str, Any]:
        """将会议录音转写为结构化片段。"""
        if not os.path.exists(file_path):
            raise FileNotFoundError("音频文件不存在")

        segments: list[dict[str, str]] = []
        duration = 0
        for item in self.stream_transcribe_audio(file_path):
            segments.append(item["segment"])
            duration = max(duration, int(item.get("duration", 0)))

        return {"segments": segments, "duration": duration}

    def stream_transcribe_audio(self, file_path: str) -> Iterator[dict[str, Any]]:
        """逐段产出会议录音转写结果。"""
        if not os.path.exists(file_path):
            raise FileNotFoundError("音频文件不存在")

        provider = (settings.asr_provider or "local").strip().lower()
        if provider == "minimax":
            yield from self._stream_transcribe_audio_remote(file_path)
            return
        if provider == "auto":
            try:
                yield from self._stream_transcribe_audio_local(file_path)
                return
            except Exception as local_error:
                try:
                    yield from self._stream_transcribe_audio_remote(file_path)
                    return
                except Exception as remote_error:
                    raise RuntimeError(
                        f"本地转写失败：{local_error}；远程转写也失败：{remote_error}"
                    ) from remote_error

        yield from self._stream_transcribe_audio_local(file_path)

    @classmethod
    def _get_local_asr_model(cls):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "未安装本地转写依赖 faster-whisper，请重新执行 pip install -r requirements.txt"
            ) from exc

        signature = (
            settings.local_asr_model_size,
            settings.local_asr_device,
            settings.local_asr_compute_type,
        )

        with cls._local_asr_lock:
            if cls._local_asr_model is None or cls._local_asr_signature != signature:
                cls._local_asr_model = WhisperModel(
                    settings.local_asr_model_size,
                    device=settings.local_asr_device,
                    compute_type=settings.local_asr_compute_type,
                )
                cls._local_asr_signature = signature

        return cls._local_asr_model

    def _stream_transcribe_audio_local(self, file_path: str) -> Iterator[dict[str, Any]]:
        model = self._get_local_asr_model()
        language = settings.local_asr_language.strip() or None
        options: dict[str, Any] = {
            "beam_size": max(settings.local_asr_beam_size, 1),
            "vad_filter": settings.local_asr_vad_filter,
        }
        if language:
            options["language"] = language

        segments_iter, _ = model.transcribe(file_path, **options)

        for segment in segments_iter:
            text = segment.text.strip()
            if not text:
                continue
            start_time = float(segment.start or 0.0)
            end_time = float(segment.end or start_time)
            yield self._build_stream_segment(
                text=text,
                start_time=start_time,
                end_time=end_time,
            )

    def _stream_transcribe_audio_remote(self, file_path: str) -> Iterator[dict[str, Any]]:
        mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        file_name = os.path.basename(file_path)

        with open(file_path, "rb") as audio_file, httpx.Client(timeout=180.0) as client:
            response = client.post(
                self.asr_endpoint,
                headers=self._authorization_headers(),
                data={"model": self.asr_model},
                files={"file": (file_name, audio_file, mime_type)},
            )
            response.raise_for_status()
            payload = response.json()

        transcript_text = (
            payload.get("text")
            or payload.get("data", {}).get("text")
            or payload.get("result", {}).get("text")
            or ""
        ).strip()
        if not transcript_text:
            return

        for segment in self._split_into_segments(transcript_text):
            yield {
                "segment": segment,
                "duration": self._parse_timestamp(segment["timestamp"]),
            }

    def _split_into_segments(self, text: str) -> list[dict[str, str]]:
        sentences = re.split(r"[\n。！？!?]+", text)
        segments: list[dict[str, str]] = []
        for index, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence:
                continue
            segments.append(
                {
                    "speaker": "会议发言",
                    "text": sentence,
                    "timestamp": self._format_timestamp(index * 10),
                }
            )
        return segments

    def _format_timestamp(self, seconds: float) -> str:
        total_seconds = max(int(seconds), 0)
        hours, remainder = divmod(total_seconds, 3600)
        minutes, secs = divmod(remainder, 60)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"

    def _parse_timestamp(self, timestamp: str) -> int:
        hours, minutes, seconds = (int(part) for part in timestamp.split(":"))
        return hours * 3600 + minutes * 60 + seconds

    def _build_stream_segment(self, text: str, start_time: float, end_time: float) -> dict[str, Any]:
        return {
            "segment": {
                "speaker": "会议发言",
                "text": text,
                "timestamp": self._format_timestamp(start_time),
            },
            "duration": int(max(end_time, start_time)),
        }

    def _parse_transcript_lines(self, transcript: str) -> list[dict[str, str]]:
        segments: list[dict[str, str]] = []
        for line in transcript.splitlines():
            line = line.strip()
            if not line:
                continue

            match = re.match(
                r"^\[(?P<timestamp>\d{2}:\d{2}:\d{2})\]\s*(?P<speaker>[^：:]+)\s*[：:]\s*(?P<text>.+)$",
                line,
            )
            if match:
                segments.append(
                    {
                        "timestamp": match.group("timestamp").strip(),
                        "speaker": match.group("speaker").strip(),
                        "text": match.group("text").strip(),
                    }
                )
                continue

            fallback_match = re.match(r"^(?P<speaker>[^：:]+)\s*[：:]\s*(?P<text>.+)$", line)
            if fallback_match:
                segments.append(
                    {
                        "timestamp": "",
                        "speaker": fallback_match.group("speaker").strip(),
                        "text": fallback_match.group("text").strip(),
                    }
                )

        return segments

    def _clean_optional_text(self, value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if text.lower() in {"null", "none", "n/a"}:
            return None
        if text in {"未指定", "未知", "待定", "无", "暂无"}:
            return None
        return text or None

    def _normalize_priority(self, value: Any) -> str:
        if not isinstance(value, str):
            return "medium"
        normalized = value.strip().lower()
        if normalized in {"high", "medium", "low"}:
            return normalized
        return "medium"

    def _normalize_match_text(self, text: str | None) -> str:
        if not text:
            return ""
        return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", text).lower()

    def _score_source_segment(
        self,
        content: str,
        assignee: str | None,
        deadline: str | None,
        segment: dict[str, str],
    ) -> float:
        segment_text = self._normalize_match_text(segment.get("text"))
        content_text = self._normalize_match_text(content)
        if not segment_text or not content_text:
            return 0.0

        score = 0.0
        if content_text in segment_text:
            score += 8.0

        overlap_chars = set(content_text) & set(segment_text)
        score += len(overlap_chars) * 0.35

        for fragment in re.split(r"[\s,，。；、/]+", content):
            normalized_fragment = self._normalize_match_text(fragment)
            if len(normalized_fragment) >= 2 and normalized_fragment in segment_text:
                score += min(3.2, len(normalized_fragment) * 0.4)

        for bonus_text, bonus_score in ((assignee, 2.2), (deadline, 1.6)):
            normalized_bonus = self._normalize_match_text(bonus_text)
            if normalized_bonus and normalized_bonus in segment_text:
                score += bonus_score

        return score

    def _match_source_segment(
        self,
        transcript_segments: list[dict[str, str]],
        content: str,
        assignee: str | None,
        deadline: str | None,
    ) -> dict[str, str] | None:
        best_segment: dict[str, str] | None = None
        best_score = 0.0

        for segment in transcript_segments:
            score = self._score_source_segment(content, assignee, deadline, segment)
            if score > best_score:
                best_score = score
                best_segment = segment

        return best_segment if best_score >= 1.8 else None

    def _normalize_todo_item(
        self,
        item: Any,
        transcript_segments: list[dict[str, str]],
    ) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None

        content = self._clean_optional_text(item.get("content"))
        if not content:
            return None

        assignee = self._clean_optional_text(item.get("assignee"))
        deadline = self._clean_optional_text(item.get("deadline"))
        source_excerpt = self._clean_optional_text(item.get("source_excerpt"))
        source_timestamp = self._clean_optional_text(item.get("source_timestamp"))
        source_speaker = self._clean_optional_text(item.get("source_speaker"))

        source_segment = None
        if not (source_excerpt and source_timestamp and source_speaker):
            source_segment = self._match_source_segment(transcript_segments, content, assignee, deadline)

        return {
            "content": content,
            "assignee": assignee,
            "deadline": deadline,
            "priority": self._normalize_priority(item.get("priority")),
            "source_excerpt": source_excerpt or source_segment.get("text") if source_segment else source_excerpt,
            "source_timestamp": (
                source_timestamp or source_segment.get("timestamp") if source_segment else source_timestamp
            ),
            "source_speaker": source_speaker or source_segment.get("speaker") if source_segment else source_speaker,
        }

    def extract_todos(self, transcript: str) -> list[dict[str, Any]]:
        prompt = f"""请从以下会议转写文本中提取待办事项，仅输出 JSON 数组，不要输出任何额外说明。
会议内容：{transcript}

输出格式：[
  {{
    "content": "待办事项内容",
    "assignee": "负责人姓名或 null",
    "deadline": "截止日期或 null",
    "priority": "high/medium/low",
    "source_excerpt": "来源发言摘录，尽量直接引用会议原话",
    "source_timestamp": "来源发言时间戳，如 00:12:30",
    "source_speaker": "来源发言人"
  }}
] 

要求：
1. 只保留明确可执行的行动项，不要输出泛泛而谈的讨论内容。
2. 如果负责人或截止时间未明确提到，请返回 null。
3. 每个待办都尽量回填最相关的来源发言；如果确实无法判断，source_excerpt/source_timestamp/source_speaker 返回 null。
4. priority 只能是 high、medium、low 三个值。"""
        try:
            response = self.chat(prompt)
            data = self._extract_json(response)
            if not isinstance(data, list):
                return []

            transcript_segments = self._parse_transcript_lines(transcript)
            normalized_todos: list[dict[str, Any]] = []
            for item in data:
                normalized = self._normalize_todo_item(item, transcript_segments)
                if normalized:
                    normalized_todos.append(normalized)
            return normalized_todos
        except Exception:
            return []

    def generate_summary(self, transcript: str) -> dict[str, Any]:
        prompt = f"""请根据以下会议转写内容生成结构化会议纪要，仅输出 JSON。
会议内容：{transcript}

输出格式：{{
  "key_topics": ["议题1", "议题2"],
  "decisions": ["决议1", "决议2"],
  "action_items": ["行动项1", "行动项2"],
  "attendees": ["参会人1", "参会人2"]
}}"""
        try:
            response = self.chat(prompt)
            data = self._extract_json(response)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {"key_topics": [], "decisions": [], "action_items": [], "attendees": []}
