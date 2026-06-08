from __future__ import annotations

from datetime import datetime
import os
import uuid
from typing import Any

import aiofiles
from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.api.v1.auth import get_current_user
from app.core.config import settings
from app.models.common import error_response, success_response
from app.services.minimax import MiniMaxService

router = APIRouter()


class MeetingResponse(BaseModel):
    meeting_id: str
    file_name: str
    file_type: str
    status: str
    created_at: str


# MVP 采用进程内存存储；部署重启后运行态数据不会保留。
meetings_db: dict[str, dict[str, Any]] = {}


def _serialize_meeting(meeting: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in meeting.items() if key not in {"file_path", "username"}}


def _get_user_meeting(meeting_id: str, username: str) -> dict[str, Any] | None:
    meeting = meetings_db.get(meeting_id)
    if not meeting or meeting.get("username") != username:
        return None
    return meeting


@router.get("/meetings")
async def list_meetings(user: dict = Depends(get_current_user)):
    """获取当前登录用户的会议列表"""
    username = user["username"]
    items = [
        _serialize_meeting(meeting)
        for meeting in meetings_db.values()
        if meeting.get("username") == username
    ]
    items.sort(key=lambda item: item["created_at"], reverse=True)
    return success_response({"items": items, "total": len(items)})


@router.post("/meetings/upload")
async def upload_meeting(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """上传会议录音"""
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in settings.allowed_extensions:
        return error_response(1001, f"不支持的格式: {ext}，支持：mp3/wav/m4a/mp4")

    content = await file.read()
    if len(content) > settings.max_file_size:
        return error_response(1002, f"文件超过 {settings.max_file_size // 1024 // 1024}MB 限制")

    meeting_id = f"mtg_{uuid.uuid4().hex[:12]}"
    file_path = os.path.join(settings.upload_dir, f"{meeting_id}{ext}")

    async with aiofiles.open(file_path, "wb") as handle:
        await handle.write(content)

    meeting = {
        "meeting_id": meeting_id,
        "file_name": file.filename,
        "file_type": ext[1:],
        "status": "pending",
        "created_at": datetime.utcnow().isoformat(),
        "username": user["username"],
        "file_path": file_path,
        "transcript": None,
        "todos": [],
        "summary": None,
    }
    meetings_db[meeting_id] = meeting
    return success_response(_serialize_meeting(meeting))


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """获取会议详情"""
    meeting = _get_user_meeting(meeting_id, user["username"])
    if not meeting:
        return error_response(2001, "会议不存在或无权访问")
    return success_response(_serialize_meeting(meeting))


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """删除会议"""
    meeting = _get_user_meeting(meeting_id, user["username"])
    if not meeting:
        return error_response(2001, "会议不存在或无权访问")

    file_path = meeting.get("file_path")
    if file_path and os.path.exists(file_path):
        os.remove(file_path)

    del meetings_db[meeting_id]
    return success_response({"meeting_id": meeting_id}, "删除成功")


@router.post("/meetings/{meeting_id}/transcribe")
async def transcribe_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """转写会议录音"""
    meeting = _get_user_meeting(meeting_id, user["username"])
    if not meeting:
        return error_response(2001, "会议不存在或无权访问")

    file_path = meeting.get("file_path")
    if not file_path or not os.path.exists(file_path):
        return error_response(2003, "录音文件不存在，请重新上传")

    try:
        minimax = MiniMaxService()
        transcription_result = await run_in_threadpool(minimax.transcribe_audio, file_path)
        segments = transcription_result.get("segments", [])
        if not segments:
            return error_response(2004, "转写结果为空，请检查录音内容后重试")
        transcript = {
            "meeting_id": meeting_id,
            "segments": segments,
            "duration": transcription_result.get("duration", 0),
        }
        meeting["status"] = "done"
        meeting["transcript"] = transcript
        return success_response(transcript)
    except Exception as exc:
        return error_response(2004, f"转写失败: {exc}")


@router.post("/meetings/{meeting_id}/todos")
async def extract_meeting_todos(meeting_id: str, user: dict = Depends(get_current_user)):
    """从转写文本中提取待办事项"""
    meeting = _get_user_meeting(meeting_id, user["username"])
    if not meeting:
        return error_response(2001, "会议不存在或无权访问")

    transcript = meeting.get("transcript")
    if not transcript:
        return error_response(2002, "请先完成转写")

    transcript_text = "\n".join(
        f"{segment['speaker']}：{segment['text']}" for segment in transcript["segments"]
    )
    minimax = MiniMaxService()
    todos = minimax.extract_todos(transcript_text)
    meeting["todos"] = todos
    return success_response({"todos": todos})


@router.post("/meetings/{meeting_id}/summary")
async def generate_meeting_summary(meeting_id: str, user: dict = Depends(get_current_user)):
    """生成会议纪要"""
    meeting = _get_user_meeting(meeting_id, user["username"])
    if not meeting:
        return error_response(2001, "会议不存在或无权访问")

    transcript = meeting.get("transcript")
    if not transcript:
        return error_response(2002, "请先完成转写")

    transcript_text = "\n".join(
        f"{segment['speaker']}：{segment['text']}" for segment in transcript["segments"]
    )
    minimax = MiniMaxService()
    summary = minimax.generate_summary(transcript_text)
    meeting["summary"] = summary
    return success_response({"summary": summary})
