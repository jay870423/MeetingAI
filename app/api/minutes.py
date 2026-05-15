from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.meeting import Meeting, MeetingStatus
from app.models.minutes import Minutes
from app.models.todo import Todo, TodoStatus
from app.schemas.minutes import MinutesGenerateRequest, MinutesResponse
from app.services.minimax_service import minimax_service
import json

router = APIRouter(prefix="/minutes", tags=["会议纪要"])

@router.post("/generate")
async def generate_minutes(
    request: MinutesGenerateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """生成会议纪要"""
    meeting = await db.get(Meeting, request.meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    if meeting.status != MeetingStatus.COMPLETED or not meeting.transcription:
        raise HTTPException(status_code=400, detail="会议尚未完成转写")
    
    # 检查是否已有纪要
    existing = await db.execute(
        select(Minutes).where(Minutes.meeting_id == request.meeting_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该会议已生成纪要，请使用更新接口")
    
    # 后台生成纪要
    background_tasks.add_task(
        _generate_minutes_task,
        request.meeting_id,
        meeting.transcription,
        request.include_key_points,
        request.include_summary,
        db
    )
    
    return {"message": "会议纪要生成中，请稍后刷新页面"}

async def _generate_minutes_task(
    meeting_id: int,
    transcription: str,
    include_key_points: bool,
    include_summary: bool,
    db: AsyncSession
):
    """后台生成会议纪要任务"""
    try:
        result = await minimax_service.generate_minutes(
            transcription,
            include_key_points=include_key_points,
            include_summary=include_summary
        )
        
        # 保存纪要
        minutes = Minutes(
            meeting_id=meeting_id,
            content=json.dumps(result, ensure_ascii=False, indent=2),
            summary=result.get("summary", ""),
            key_points=json.dumps(result.get("key_points", []), ensure_ascii=False)
        )
        db.add(minutes)
        
        # 自动创建待办事项
        action_items = result.get("action_items", [])
        for item in action_items:
            todo = Todo(
                meeting_id=meeting_id,
                content=item.get("task", ""),
                assignee=item.get("assignee"),
                due_date=item.get("due_date"),
                status=TodoStatus.PENDING
            )
            db.add(todo)
        
        await db.commit()
    except Exception:
        await db.rollback()

@router.get("/meeting/{meeting_id}", response_model=MinutesResponse)
async def get_meeting_minutes(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """获取会议的纪要"""
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    result = await db.execute(
        select(Minutes).where(Minutes.meeting_id == meeting_id)
    )
    minutes = result.scalar_one_or_none()
    
    if not minutes:
        raise HTTPException(status_code=404, detail="该会议尚未生成纪要")
    
    return minutes

@router.put("/meeting/{meeting_id}")
async def update_minutes(
    meeting_id: int,
    request: MinutesGenerateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """更新会议纪要（重新生成）"""
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    if meeting.status != MeetingStatus.COMPLETED or not meeting.transcription:
        raise HTTPException(status_code=400, detail="会议尚未完成转写")
    
    # 删除旧纪要
    result = await db.execute(
        select(Minutes).where(Minutes.meeting_id == meeting_id)
    )
    old_minutes = result.scalar_one_or_none()
    if old_minutes:
        await db.delete(old_minutes)
    
    # 重新生成
    background_tasks.add_task(
        _generate_minutes_task,
        meeting_id,
        meeting.transcription,
        request.include_key_points,
        request.include_summary,
        db
    )
    
    return {"message": "会议纪要更新中，请稍后刷新页面"}
