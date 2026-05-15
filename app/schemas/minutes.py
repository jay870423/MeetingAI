from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

class MinutesBase(BaseModel):
    content: str
    summary: Optional[str] = None
    key_points: Optional[str] = None

class MinutesCreate(MinutesBase):
    meeting_id: int

class MinutesResponse(MinutesBase):
    id: int
    meeting_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class MinutesGenerateRequest(BaseModel):
    meeting_id: int
    include_key_points: bool = True
    include_summary: bool = True
