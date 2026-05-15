from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.models.user import User
from app.models.meeting import Meeting, MeetingStatus
from app.models.minutes import Minutes
from app.schemas.meeting import MeetingResponse, MeetingListResponse
from app.services.minimax_service import minimax_service
import os
import uuid
import aiofiles
from typing import Optional

router = APIRouter(prefix="/meetings", tags=["会议"])

@router.post("/upload", response_model=MeetingResponse)
async def upload_meeting_audio(
    background_tasks: BackgroundTasks,
    title: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """上传会议音频文件并创建会议记录"""
    # 验证文件类型
    allowed_types = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/m4a"]
    content_type = file.content_type or "audio/mpeg"
    
    if content_type not in allowed_types and not any(file.filename.endswith(ext) for ext in ['.mp3', '.wav', '.m4a', '.ogg', '.mp4']):
        raise HTTPException(status_code=400, detail="不支持的文件格式")
    
    # 保存文件
    file_ext = os.path.splitext(file.filename)[1] if file.filename else ".mp3"
    unique_filename = f"{uuid.uuid4()}{file_ext}"
    file_path = os.path.join(settings.UPLOAD_DIR, unique_filename)
    
    async with aiofiles.open(file_path, 'wb') as out_file:
        content = await file.read()
        await out_file.write(content)
    
    # 创建会议记录
    meeting = Meeting(
        user_id=current_user.id,
        title=title,
        original_filename=file.filename,
        file_path=file_path,
        status=MeetingStatus.PENDING
    )
    db.add(meeting)
    await db.commit()
    await db.refresh(meeting)
    
    # 后台处理转写
    background_tasks.add_task(process_transcription, meeting.id, file_path, db)
    
    return meeting

async def process_transcription(meeting_id: int, file_path: str, db: AsyncSession):
    """后台处理音频转写"""
    try:
        # 更新状态为处理中
        meeting = await db.get(Meeting, meeting_id)
        if not meeting:
            return
        
        meeting.status = MeetingStatus.PROCESSING
        await db.commit()
        
        # 调用MiniMax API转写
        try:
            transcription = await minimax_service.speech_to_text(file_path)
            if transcription:
                meeting.transcription = transcription
                meeting.status = MeetingStatus.COMPLETED
            else:
                meeting.status = MeetingStatus.FAILED
                meeting.error_message = "转写结果为空"
        except Exception as e:
            meeting.status = MeetingStatus.FAILED
            meeting.error_message = str(e)
        
        await db.commit()
    except Exception as e:
        await db.rollback()

@router.get("/", response_model=MeetingListResponse)
async def list_meetings(
    skip: int = 0,
    limit: int = 20,
    status_filter: Optional[MeetingStatus] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """获取用户的会议列表"""
    query = select(Meeting).where(Meeting.user_id == current_user.id)
    
    if status_filter:
        query = query.where(Meeting.status == status_filter)
    
    # 获取总数
    count_query = select(func.count(Meeting.id)).where(Meeting.user_id == current_user.id)
    if status_filter:
        count_query = count_query.where(Meeting.status == status_filter)
    total_result = await db.execute(count_query)
    total = total_result.scalar()
    
    # 获取分页数据
    query = query.order_by(Meeting.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(query)
    meetings = result.scalars().all()
    
    return {"total": total, "items": meetings}

@router.get("/{meeting_id}", response_model=MeetingResponse)
async def get_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """获取会议详情"""
    meeting = await db.get(Meeting, meeting_id)
    
    if not meeting:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    if meeting.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此会议")
    
    return meeting

@router.delete("/{meeting_id}")
async def delete_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """删除会议"""
    meeting = await db.get(Meeting, meeting_id)
    
    if not meeting:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    if meeting.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此会议")
    
    # 删除关联的纪要和待办
    await db.execute(select(Minutes).where(Minutes.meeting_id == meeting_id))
    minutes_result = await db.execute(select(Minutes).where(Minutes.meeting_id == meeting_id))
    for minutes in minutes_result.scalars():
        await db.delete(minutes)
    
    # 删除文件
    if meeting.file_path and os.path.exists(meeting.file_path):
        os.remove(meeting.file_path)
    
    await db.delete(meeting)
    await db.commit()
    
    return {"message": "删除成功"}
