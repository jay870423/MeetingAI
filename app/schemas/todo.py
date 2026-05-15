from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from enum import Enum

class TodoStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"

class TodoBase(BaseModel):
    content: str
    assignee: Optional[str] = None
    due_date: Optional[str] = None

class TodoCreate(TodoBase):
    meeting_id: int

class TodoUpdate(BaseModel):
    content: Optional[str] = None
    assignee: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[TodoStatus] = None

class TodoResponse(TodoBase):
    id: int
    meeting_id: int
    status: TodoStatus
    created_at: datetime

    class Config:
        from_attributes = True

class TodoListResponse(BaseModel):
    total: int
    items: List[TodoResponse]
