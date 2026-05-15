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
    await client.post("/api/v1/auth/register", json={
        "username": "testuser_todo",
        "email": "todo@example.com",
        "password": "testpass123"
    })
    response = await client.post("/api/v1/auth/login", json={
        "username": "testuser_todo",
        "password": "testpass123"
    })
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}

@pytest.mark.asyncio
async def test_create_todo_meeting_not_found(client, auth_headers):
    response = await client.post("/api/v1/todos/", headers=auth_headers, json={
        "meeting_id": 99999,
        "content": "Test todo"
    })
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_update_todo_not_found(client, auth_headers):
    response = await client.patch("/api/v1/todos/99999", headers=auth_headers, json={
        "content": "Updated content"
    })
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_delete_todo_not_found(client, auth_headers):
    response = await client.delete("/api/v1/todos/99999", headers=auth_headers)
    assert response.status_code == 404
