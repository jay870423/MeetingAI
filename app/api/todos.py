from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.meeting import Meeting, MeetingStatus
from app.models.todo import Todo, TodoStatus
from app.schemas.todo import TodoCreate, TodoUpdate, TodoResponse, TodoListResponse
from app.services.minimax_service import minimax_service
from typing import Optional

router = APIRouter(prefix="/todos", tags=["待办事项"])

@router.post("/", response_model=TodoResponse)
async def create_todo(
    todo_data: TodoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """创建待办事项"""
    # 验证会议是否存在且属于当前用户
    meeting = await db.get(Meeting, todo_data.meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    todo = Todo(
        meeting_id=todo_data.meeting_id,
        content=todo_data.content,
        assignee=todo_data.assignee,
        due_date=todo_data.due_date,
        status=TodoStatus.PENDING
    )
    db.add(todo)
    await db.commit()
    await db.refresh(todo)
    
    return todo

@router.get("/meeting/{meeting_id}", response_model=TodoListResponse)
async def list_meeting_todos(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """获取会议的待办事项列表"""
    # 验证会议所有权
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    result = await db.execute(
        select(Todo).where(Todo.meeting_id == meeting_id).order_by(Todo.created_at.desc())
    )
    todos = result.scalars().all()
    
    return {"total": len(todos), "items": todos}

@router.patch("/{todo_id}", response_model=TodoResponse)
async def update_todo(
    todo_id: int,
    update_data: TodoUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """更新待办事项"""
    todo = await db.get(Todo, todo_id)
    if not todo:
        raise HTTPException(status_code=404, detail="待办事项不存在")
    
    # 验证会议所有权
    meeting = await db.get(Meeting, todo.meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此待办事项")
    
    # 更新字段
    if update_data.content is not None:
        todo.content = update_data.content
    if update_data.assignee is not None:
        todo.assignee = update_data.assignee
    if update_data.due_date is not None:
        todo.due_date = update_data.due_date
    if update_data.status is not None:
        todo.status = update_data.status
    
    await db.commit()
    await db.refresh(todo)
    
    return todo

@router.delete("/{todo_id}")
async def delete_todo(
    todo_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """删除待办事项"""
    todo = await db.get(Todo, todo_id)
    if not todo:
        raise HTTPException(status_code=404, detail="待办事项不存在")
    
    # 验证会议所有权
    meeting = await db.get(Meeting, todo.meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此待办事项")
    
    await db.delete(todo)
    await db.commit()
    
    return {"message": "删除成功"}

@router.post("/extract/{meeting_id}")
async def extract_todos_from_meeting(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """从会议转写文本中提取待办事项"""
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会议不存在")
    
    if meeting.status != MeetingStatus.COMPLETED or not meeting.transcription:
        raise HTTPException(status_code=400, detail="会议尚未完成转写")
    
    # 异步提取待办
    background_tasks.add_task(
        _extract_todos_task,
        meeting_id,
        meeting.transcription,
        db
    )
    
    return {"message": "待办事项提取中，请稍后刷新页面"}

async def _extract_todos_task(meeting_id: int, transcription: str, db: AsyncSession):
    """后台提取待办事项"""
    try:
        todos_data = await minimax_service.extract_todos(transcription)
        
        for todo_data in todos_data:
            todo = Todo(
                meeting_id=meeting_id,
                content=todo_data.get("content", ""),
                assignee=todo_data.get("assignee"),
                due_date=todo_data.get("due_date"),
                status=TodoStatus.PENDING
            )
            db.add(todo)
        
        await db.commit()
    except Exception:
        await db.rollback()
