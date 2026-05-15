# Meeting Assistant Backend

## 项目结构

```
backend/
├── app/
│   ├── api/              # API路由
│   │   ├── auth.py       # 认证接口
│   │   ├── meetings.py   # 会议接口
│   │   ├── minutes.py    # 会议纪要接口
│   │   └── todos.py      # 待办事项接口
│   ├── core/             # 核心配置
│   │   ├── config.py     # 应用配置
│   │   ├── database.py   # 数据库连接
│   │   └── security.py   # JWT认证
│   ├── models/           # SQLAlchemy模型
│   │   ├── user.py
│   │   ├── meeting.py
│   │   ├── minutes.py
│   │   └── todo.py
│   ├── schemas/          # Pydantic schemas
│   │   ├── user.py
│   │   ├── meeting.py
│   │   ├── minutes.py
│   │   └── todo.py
│   ├── services/         # 业务服务
│   │   └── minimax_service.py  # MiniMax API封装
│   └── main.py           # FastAPI应用入口
├── tests/                # 测试文件
├── uploads/              # 上传文件目录
├── requirements.txt      # 依赖
└── .env                  # 环境变量（需创建）
```

## 快速开始

1. 安装依赖：
```bash
pip install -r requirements.txt
```

2. 创建环境变量文件：
```bash
cp .env.example .env
# 编辑.env填入MiniMax API密钥
```

3. 运行服务：
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

4. 访问API文档：http://localhost:8000/docs

## API接口

### 认证 (/api/v1/auth)
- `POST /register` - 用户注册
- `POST /login` - 用户登录
- `GET /me` - 获取当前用户信息

### 会议 (/api/v1/meetings)
- `POST /upload` - 上传会议音频
- `GET /` - 获取会议列表
- `GET /{id}` - 获取会议详情
- `DELETE /{id}` - 删除会议

### 待办事项 (/api/v1/todos)
- `POST /` - 创建待办
- `GET /meeting/{id}` - 获取会议待办列表
- `PATCH /{id}` - 更新待办
- `DELETE /{id}` - 删除待办
- `POST /extract/{id}` - 从会议转写中提取待办

### 会议纪要 (/api/v1/minutes)
- `POST /generate` - 生成会议纪要
- `GET /meeting/{id}` - 获取会议纪要
- `PUT /meeting/{id}` - 更新会议纪要

## 技术栈

- FastAPI - Web框架
- SQLAlchemy + aiosqlite - 异步数据库
- python-jose - JWT认证
- passlib + bcrypt - 密码加密
- MiniMax API - 语音转写和文本生成
