import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest.fixture
async def auth_headers(client):
    """创建测试用户并登录"""
    # 注册
    await client.post("/api/v1/auth/register", json={
        "username": "testuser_meeting",
        "email": "meeting@example.com",
        "password": "testpass123"
    })
    # 登录
    response = await client.post("/api/v1/auth/login", json={
        "username": "testuser_meeting",
        "password": "testpass123"
    })
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}

@pytest.mark.asyncio
async def test_list_meetings_empty(client, auth_headers):
    response = await client.get("/api/v1/meetings", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 0
    assert data["items"] == []

@pytest.mark.asyncio
async def test_get_meeting_not_found(client, auth_headers):
    response = await client.get("/api/v1/meetings/99999", headers=auth_headers)
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_delete_meeting_not_found(client, auth_headers):
    response = await client.delete("/api/v1/meetings/99999", headers=auth_headers)
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_upload_without_auth(client):
    response = await client.post(
        "/api/v1/meetings/upload",
        data={"title": "Test Meeting"}
    )
    assert response.status_code == 403  # No auth token
