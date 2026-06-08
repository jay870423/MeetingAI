from __future__ import annotations

import json
import mimetypes
import os
import re
from typing import Any

import httpx

from app.core.config import settings


class MiniMaxService:
    """MiniMax API 封装，支持会议转写、待办提取与纪要生成。"""

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or settings.minimax_api_key
        self.endpoint = settings.minimax_endpoint
        self.asr_endpoint = settings.minimax_asr_endpoint
        self.model = settings.minimax_model
        self.asr_model = settings.minimax_asr_model

    def _authorization_headers(self) -> dict[str, str]:
        if not self.api_key:
            raise ValueError("MiniMax API key 未配置")
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

    def transcribe_audio(self, file_path: str) -> list[dict[str, str]]:
        """调用 MiniMax 远程 ASR 接口完成音频转写。"""
        if not os.path.exists(file_path):
            raise FileNotFoundError("音频文件不存在")

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
            return []
        return self._split_into_segments(transcript_text)

    def _split_into_segments(self, text: str) -> list[dict[str, str]]:
        sentences = re.split(r"[\n。？！!?]+", text)
        speakers = ["参会人A", "参会人B", "参会人C", "参会人D"]
        segments: list[dict[str, str]] = []
        for index, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence:
                continue
            segments.append(
                {
                    "speaker": speakers[index % len(speakers)],
                    "text": sentence,
                    "timestamp": f"00:{index:02d}:00",
                }
            )
        return segments

    def extract_todos(self, transcript: str) -> list[dict[str, Any]]:
        prompt = f"""请从以下会议转写文本中提取待办事项，仅输出 JSON 数组。

会议内容：
{transcript}

输出格式：
[
  {{
    "content": "待办事项内容",
    "assignee": "负责人姓名或未指定",
    "deadline": "截止日期或 null",
    "priority": "high/medium/low"
  }}
]"""
        try:
            response = self.chat(prompt)
            data = self._extract_json(response)
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def generate_summary(self, transcript: str) -> dict[str, Any]:
        prompt = f"""请根据以下会议转写内容生成结构化会议纪要，仅输出 JSON。

会议内容：
{transcript}

输出格式：
{{
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
