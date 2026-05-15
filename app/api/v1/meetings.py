from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
import os, uuid, aiofiles

from app.core.config import settings
from app.models.common import success_response, error_response
from app.services.minimax import MiniMaxService
from app.api.v1.auth import get_current_user

router = APIRouter()
security = HTTPBearer(auto_error=False)


class MeetingResponse(BaseModel):
    meeting_id: str
    file_name: str
    file_type: str
    status: str
    created_at: str


# 内存存储（MVP）
meetings_db: dict = {}


@router.post("/meetings/upload")
async def upload_meeting(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """上传会议录音"""
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in settings.allowed_extensions:
        return error_response(1001, f"不支持的格式: {ext}，支持：mp3/wav/m4a/mp4")

    # 检查大小
    content = await file.read()
    if len(content) > settings.max_file_size:
        return error_response(1002, f"文件超过 {settings.max_file_size // 1024 // 1024}MB 限制")

    meeting_id = f"mtg_{uuid.uuid4().hex[:12]}"
    file_path = os.path.join(settings.upload_dir, f"{meeting_id}{ext}")

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    meeting = {
        "meeting_id": meeting_id,
        "file_name": file.filename,
        "file_type": ext[1:],
        "status": "pending",
        "created_at": datetime.utcnow().isoformat(),
        "file_path": file_path,
        "transcript": None,
        "todos": [],
        "summary": None,
    }
    meetings_db[meeting_id] = meeting
    return success_response({k: v for k, v in meeting.items() if k != "file_path"})


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """获取会议详情"""
    meeting = meetings_db.get(meeting_id)
    if not meeting:
        return error_response(2001, "会议不存在")
    return success_response({k: v for k, v in meeting.items() if k != "file_path"})


@router.post("/meetings/{meeting_id}/transcribe")
async def transcribe_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """转写会议录音（MiniMax ASR）"""
    meeting = meetings_db.get(meeting_id)
    if not meeting:
        return error_response(2001, "会议不存在")

    file_path = meeting.get("file_path")
    if not file_path or not os.path.exists(file_path):
        return error_response(2003, "文件不存在，请重新上传")

    try:
        # 调用 MiniMax ASR
        minimax = MiniMaxService()
        segments = minimax.transcribe_audio(file_path)

        transcript = {
            "meeting_id": meeting_id,
            "segments": segments,
            "duration": 0,
        }
        meeting["status"] = "done"
        meeting["transcript"] = transcript
        return success_response(transcript)
    except Exception as e:
        return error_response(2004, f"转写失败: {str(e)}")


@router.post("/meetings/{meeting_id}/todos")
async def extract_meeting_todos(meeting_id: str, user: dict = Depends(get_current_user)):
    """从转写内容提取待办事项（MiniMax AI）"""
    meeting = meetings_db.get(meeting_id)
    if not meeting:
        return error_response(2001, "会议不存在")

    if not meeting.get("transcript"):
        return error_response(2002, "请先完成转写")

    # 将转写文本拼接
    segments = meeting["transcript"]["segments"]
    transcript_text = "\n".join([f"{s['speaker']}：{s['text']}" for s in segments])

    # 调用 MiniMax 提取待办
    minimax = MiniMaxService()
    todos = minimax.extract_todos(transcript_text)

    meeting["todos"] = todos
    return success_response({"todos": todos})


@router.post("/meetings/{meeting_id}/summary")
async def generate_meeting_summary(meeting_id: str, user: dict = Depends(get_current_user)):
    """生成会议纪要（MiniMax AI）"""
    meeting = meetings_db.get(meeting_id)
    if not meeting:
        return error_response(2001, "会议不存在")

    if not meeting.get("transcript"):
        return error_response(2002, "请先完成转写")

    segments = meeting["transcript"]["segments"]
    transcript_text = "\n".join([f"{s['speaker']}：{s['text']}" for s in segments])

    minimax = MiniMaxService()
    summary = minimax.generate_summary(transcript_text)

    meeting["summary"] = summary
    return success_response({"summary": summary})
