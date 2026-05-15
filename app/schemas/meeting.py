from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from enum import Enum

class MeetingStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

class MeetingBase(BaseModel):
    title: str

class MeetingCreate(MeetingBase):
    pass

class MeetingResponse(MeetingBase):
    id: int
    user_id: int
    original_filename: Optional[str] = None
    status: MeetingStatus
    transcription: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class MeetingListResponse(BaseModel):
    total: int
    items: List[MeetingResponse]
