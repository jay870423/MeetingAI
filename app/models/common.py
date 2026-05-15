from pydantic import BaseModel
from typing import Any, Optional


class ApiResponse(BaseModel):
    code: int = 0
    message: str = "success"
    data: Optional[Any] = None


def success_response(data: Any = None, message: str = "success"):
    return {"code": 0, "message": message, "data": data}


def error_response(code: int, message: str):
    return {"code": code, "message": message, "data": None}
