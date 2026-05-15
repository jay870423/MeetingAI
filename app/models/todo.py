from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, Enum as SQLEnum
from sqlalchemy.sql import func
from app.core.database import Base
import enum

class TodoStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"

class Todo(Base):
    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    content = Column(Text, nullable=False)
    assignee = Column(String(100), nullable=True)
    due_date = Column(String(50), nullable=True)
    status = Column(SQLEnum(TodoStatus), default=TodoStatus.PENDING)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
