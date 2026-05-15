# MeetingAI 智能会议助手

AI驱动的会议管理平台，提供会议音频上传、智能转写、会议纪要生成、待办事项提取一站式服务。

## 功能特性

- 会议音频上传与智能转写
- AI自动生成结构化会议纪要
- 从会议讨论中智能提取待办事项
- 用户注册与JWT安全认证
- 会议列表、详情、删除管理

## 技术栈

| 模块 | 技术 |
|------|------|
| Web框架 | FastAPI |
| 数据库 | SQLAlchemy + aiosqlite |
| AI服务 | MiniMax API |
| 认证 | python-jose + JWT |

## 项目结构

```
MeetingAI/
├── app/
│   ├── api/        # 路由（auth/meetings/minutes/todos）
│   ├── core/       # 核心（config/database/security）
│   ├── models/     # 数据模型
│   ├── schemas/    # Pydantic模型
│   └── services/   # MiniMax服务封装
├── tests/          # 单元测试
├── uploads/        # 上传文件
└── requirements.txt
```

## 快速部署

```bash
pip install -r requirements.txt
cp .env.example .env
# 填入 MINIMAX_API_KEY
uvicorn app.main:app --host 0.0.0.0 --port 8989
```

## API文档

http://localhost:8989/docs

## 服务地址

- 后端：http://81.70.144.73:8989
- 前端：http://81.70.144.73:5174

## 许可证

MIT License

