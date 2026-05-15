import httpx
import json
import re
import base64
from typing import Optional
from app.core.config import settings


class MiniMaxService:
    """MiniMax API 客户端，支持 Anthropic 兼容格式"""

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or settings.minimax_api_key
        self.endpoint = settings.minimax_endpoint
        self.model = settings.minimax_model

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def chat(self, prompt: str, system: str = "你是一个专业的AI会议助手。") -> str:
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
            response = client.post(self.endpoint, json=payload, headers=self._headers())
            response.raise_for_status()
            result = response.json()
            return result["choices"][0]["message"]["content"]

    def _is_valid_json(self, text: str) -> bool:
        """验证是否为有效 JSON"""
        try:
            json.loads(text)
            return True
        except (json.JSONDecodeError, ValueError):
            return False

    def _extract_json(self, text: str) -> dict:
        """4级容错 JSON 提取"""
        # 方法1：直接解析
        try:
            return json.loads(text.strip())
        except (json.JSONDecodeError, ValueError):
            pass

        # 方法2：提取 code block
        for pattern in [r"```json\s*([\s\S]+?)\s*```", r"```\s*([\s\S]+?)\s*```"]:
            match = re.search(pattern, text)
            if match:
                candidate = match.group(1).strip()
                if self._is_valid_json(candidate):
                    return json.loads(candidate)

        # 方法3：找最后一个 JSON 对象
        starts = [m.start() for m in re.finditer(r"\{", text)]
        for start in reversed(starts):
            try:
                candidate = text[start:]
                json.loads(candidate)
                return json.loads(candidate)
            except (json.JSONDecodeError, ValueError):
                continue

        # 方法4：括号匹配解析器
        depth = 0
        start_idx = -1
        in_string = False
        escape_next = False
        for i, ch in enumerate(text):
            if escape_next:
                escape_next = False
                continue
            if ch == "\\":
                escape_next = True
                continue
            if ch == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                if start_idx == -1:
                    start_idx = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start_idx != -1:
                    candidate = text[start_idx : i + 1]
                    if self._is_valid_json(candidate):
                        return json.loads(candidate)

        raise ValueError(f"无法从响应中提取 JSON: {text[:200]}")

    def transcribe_audio(self, file_path: str) -> list:
        """用本地 Whisper 将音频文件转写为文字"""
        import whisper
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = whisper.load_model("base", device=device)

        result = model.transcribe(file_path, language="zh")
        text = result.get("text", "").strip()
        if not text:
            return []

        segments = self._split_into_segments(text)
        return segments

    def _split_into_segments(self, text: str) -> list:
        """将长文本拆分为带说话人的片段"""
        # 按换行或句号拆分句子
        sentences = re.split(r'[\n。.]+', text)
        segments = []
        speakers = ["参会人A", "参会人B", "参会人C", "参会人D"]
        for i, sent in enumerate(sentences):
            sent = sent.strip()
            if not sent:
                continue
            speaker = speakers[i % len(speakers)]
            segments.append({
                "speaker": speaker,
                "text": sent,
                "timestamp": f"00:{i:02d}:00",
            })
        return segments

    def extract_todos(self, transcript: str) -> list:
        """从转写文本提取待办事项"""
        prompt = f"""从以下会议转写文本中提取待办事项，输出 JSON 数组格式：
        
{transcript}

输出格式（仅输出 JSON，不要其他文字）：
[
  {{
    "content": "待办事项内容",
    "assignee": "负责人姓名或'未指定'",
    "deadline": "截止日期或null",
    "priority": "high/medium/low"
  }}
]"""
        try:
            response = self.chat(prompt)
            data = self._extract_json(response)
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def generate_summary(self, transcript: str) -> dict:
        """生成结构化会议纪要"""
        prompt = f"""根据以下会议转写内容，生成结构化会议纪要，输出 JSON 格式：

{transcript}

输出格式（仅输出 JSON，不要其他文字）：
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
