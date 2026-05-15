from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from jose import jwt, JWTError
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
from app.core.config import settings
from app.models.common import success_response, error_response

router = APIRouter()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class LoginRequest(BaseModel):
    username: str
    password: str


# 内存用户存储（MVP 阶段，生产环境用数据库）
USERS = {
    "admin": pwd_context.hash("meeting2025"),
    "test": pwd_context.hash("test123"),
}


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(days=settings.access_token_expire_days)
    payload = {"sub": username, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """JWT 验证依赖：直接从 Authorization header 提取 Bearer token"""
    if authorization is None:
        raise HTTPException(status_code=401, detail="未提供认证信息")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="无效的认证格式")

    token = parts[1]
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        username = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="无效的认证信息")
        return {"username": username}
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 已过期")


@router.post("/auth/login")
async def login(req: LoginRequest):
    """登录获取 JWT Token"""
    if req.username not in USERS:
        return error_response(1001, "用户名或密码错误")

    if not verify_password(req.password, USERS[req.username]):
        return error_response(1001, "用户名或密码错误")

    token = create_token(req.username)
    return success_response({"token": token, "username": req.username})
