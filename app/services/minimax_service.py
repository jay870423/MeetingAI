import httpx
import json
from typing import Optional, Dict, Any
from app.core.config import settings

class MiniMaxService:
    """MiniMax API封装"""
    
    def __init__(self, api_key: Optional[str] = None, group_id: Optional[str] = None):
        self.api_key = api_key or settings.MINIMAX_API_KEY
        self.group_id = group_id or settings.MINIMAX_GROUP_ID
        self.base_url = settings.MINIMAX_API_URL
    
    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
    
    async def speech_to_text(self, audio_file_path: str, language: str = "zh") -> Optional[str]:
        """
        使用MiniMax API进行语音转文字
        支持音频文件: mp3, wav, m4a, ogg
        """
        if not self.api_key:
            raise ValueError("MiniMax API key not configured")
        
        # 使用语音识别API
        url = f"{self.base_url}/speech/recognitions"
        
        files = {
            'file': open(audio_file_path, 'rb'),
        }
        
        data = {
            'language': language,
            'group_id': self.group_id
        }
        
        headers = {"Authorization": f"Bearer {self.api_key}"}
        
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    url,
                    files=files,
                    data=data,
                    headers=headers
                )
                
            if response.status_code == 200:
                result = response.json()
                return result.get('data', {}).get('text', '')
            else:
                raise Exception(f"API error: {response.status_code} - {response.text}")
        except Exception as e:
            raise Exception(f"Speech to text failed: {str(e)}")
        finally:
            pass  # File will be closed automatically
    
    async def generate_minutes(self, transcription: str, include_key_points: bool = True, include_summary: bool = True) -> Dict[str, Any]:
        """
        使用MiniMax API生成会议纪要
        使用文本补全API来生成结构化的会议纪要
        """
        if not self.api_key:
            raise ValueError("MiniMax API key not configured")
        
        prompt = self._build_minutes_prompt(transcription, include_key_points, include_summary)
        
        url = f"{self.base_url}/text/chatcompletion_v2"
        
        payload = {
            "model": "abab6.5s-chat",
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "group_id": self.group_id,
            "tokens_to_generate": 2048,
            "temperature": 0.7
        }
        
        headers = self._get_headers()
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
        
        if response.status_code == 200:
            result = response.json()
            content = result.get('choices', [{}])[0].get('messages', [{}])[0].get('text', '')
            return self._parse_minutes_response(content)
        else:
            raise Exception(f"API error: {response.status_code} - {response.text}")
    
    def _build_minutes_prompt(self, transcription: str, include_key_points: bool, include_summary: bool) -> str:
        """构建生成会议纪要的提示词"""
        parts = [
            "请根据以下会议录音转写文本，生成结构化的会议纪要：",
            "",
            "---会议录音转写---",
            transcription,
            "---结束---",
            "",
            "请按以下JSON格式输出会议纪要（只输出JSON，不要其他内容）：",
            "{",
            '  "summary": "会议摘要（100-200字）",',
            '  "key_points": ["要点1", "要点2", "要点3"],',
            '  "action_items": [{"task": "任务描述", "assignee": "负责人", "due_date": "截止日期"}, ...]',
            "}"
        ]
        
        if not include_key_points:
            parts[10] = '  "action_items": [...]'
        if not include_summary:
            parts[8] = '  "summary": ""'
            
        return "\n".join(parts)
    
    def _parse_minutes_response(self, content: str) -> Dict[str, Any]:
        """解析API返回的会议纪要内容"""
        try:
            # 尝试提取JSON
            json_str = content.strip()
            if json_str.startswith("```"):
                json_str = json_str.split("```")[1]
                if json_str.startswith("json"):
                    json_str = json_str[4:]
            
            data = json.loads(json_str)
            return {
                "summary": data.get("summary", ""),
                "key_points": data.get("key_points", []),
                "action_items": data.get("action_items", [])
            }
        except json.JSONDecodeError:
            return {
                "summary": content[:500] if len(content) > 500 else content,
                "key_points": [],
                "action_items": []
            }
    
    async def extract_todos(self, transcription: str) -> list:
        """
        从会议转写文本中提取待办事项
        """
        if not self.api_key:
            raise ValueError("MiniMax API key not configured")
        
        prompt = f"""请从以下会议文本中提取所有待办事项，以JSON数组格式返回。

---会议文本---
{transcription}
---结束---

请按以下JSON格式输出（只输出JSON）：
[
  {{
    "content": "待办事项描述",
    "assignee": "负责人（从文本中推断，未提及则为null）",
    "due_date": "截止日期（从文本中推断，未提及则为null）"
  }}
]

如果没有待办事项，返回空数组：[]"""

        url = f"{self.base_url}/text/chatcompletion_v2"
        
        payload = {
            "model": "abab6.5s-chat",
            "messages": [{"role": "user", "content": prompt}],
            "group_id": self.group_id,
            "tokens_to_generate": 1024,
            "temperature": 0.3
        }
        
        headers = self._get_headers()
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
        
        if response.status_code == 200:
            result = response.json()
            content = result.get('choices', [{}])[0].get('messages', [{}])[0].get('text', '')
            return self._parse_todos_response(content)
        else:
            raise Exception(f"API error: {response.status_code} - {response.text}")
    
    def _parse_todos_response(self, content: str) -> list:
        """解析待办事项响应"""
        try:
            json_str = content.strip()
            if json_str.startswith("```"):
                json_str = json_str.split("```")[1]
                if json_str.startswith("json"):
                    json_str = json_str[4:]
            return json.loads(json_str)
        except json.JSONDecodeError:
            return []

# 全局单例
minimax_service = MiniMaxService()
