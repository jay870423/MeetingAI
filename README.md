# MeetingAI 智能会议助手

MeetingAI 是一套独立运行的会议 AI 工具，面向会议录音处理场景，提供账号登录、录音上传、实时转写、待办提取和结构化纪要输出能力。当前仓库已经整理为前后端一体化结构，可独立部署到 `5174` 前端和 `8989` 后端，不依赖现有主站 Nginx 配置。

## 当前能力

- 账号登录鉴权，基于 JWT 访问后端接口
- 会议录音上传，当前前端支持 `mp3 / wav / m4a / mp4`
- 流式会议转写，支持逐段输出转写结果
- 转写阅读工作台，支持自动跟随、暂停跟随、回到最新
- 流式待办提取，支持逐项输出任务卡片
- 待办来源回填，支持展示来源发言、来源时间、来源发言人
- 会议纪要生成，输出关键议题、决议事项、行动项、参会人员
- 默认本地 ASR 转写，避免依赖不稳定的远程语音接口
- 支持独立端口部署，不影响主站现有域名和代理配置

## 最近更新

- 新增流式转写接口：`/api/v1/meetings/{meeting_id}/transcribe/stream`
- 新增流式待办接口：`/api/v1/meetings/{meeting_id}/todos/stream`
- 优化转写阅读体验：最新片段高亮、识别时间提示、自动跟随控制
- 优化待办提取体验：过程进度、进入动画、卡片展开查看来源发言
- 待办结果支持回填 `source_excerpt / source_timestamp / source_speaker`

## 技术栈

- 后端：FastAPI
- 前端：Vite + React + TypeScript
- 大模型：MiniMax
- 默认语音识别：`faster-whisper` 本地 ASR
- 部署方式：systemd + 前后端独立服务

## 项目结构

```text
MeetingAI/
├─ app/                  # FastAPI 后端
├─ frontend/             # Vite + React 前端
├─ deploy/               # systemd 服务文件与发布脚本
├─ tests/                # 测试样例
├─ uploads/              # 上传目录（运行时生成）
├─ .env.example          # 环境变量示例
└─ requirements.txt
```

## 本地运行

### 1. 启动后端

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8989
```

后端默认说明：

- 默认 `ASR_PROVIDER=local`
- 默认使用 `faster-whisper` 在本机完成转写
- 首次转写时会自动下载 Whisper 模型，第一次耗时会更长
- 若服务器无法直连 Hugging Face，建议在 `.env` 中设置 `HF_ENDPOINT=https://hf-mirror.com`
- 如需切换为远程语音接口，可在 `.env` 中调整 `ASR_PROVIDER=minimax`

健康检查：

```bash
curl http://127.0.0.1:8989/health
```

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

默认访问地址：

- 本地前端：`http://127.0.0.1:5174`
- 本地后端：`http://127.0.0.1:8989`

前端会优先读取环境变量 `VITE_API_BASE_URL`。未配置时默认请求：

```text
http://当前主机:8989/api/v1
```

## 核心接口

### 鉴权

- `POST /api/v1/auth/login`

### 会议

- `GET /api/v1/meetings`
- `POST /api/v1/meetings/upload`
- `GET /api/v1/meetings/{meeting_id}`
- `DELETE /api/v1/meetings/{meeting_id}`

### 转写

- `POST /api/v1/meetings/{meeting_id}/transcribe`
- `POST /api/v1/meetings/{meeting_id}/transcribe/stream`

### 待办提取

- `POST /api/v1/meetings/{meeting_id}/todos`
- `POST /api/v1/meetings/{meeting_id}/todos/stream`

### 会议纪要

- `POST /api/v1/meetings/{meeting_id}/summary`

## 关键环境变量

`.env.example` 已提供默认示例，下面是当前最关键的配置项：

```env
MINIMAX_API_KEY=
MINIMAX_ENDPOINT=https://api.minimaxi.com/v1/chat/completions
MINIMAX_ASR_ENDPOINT=https://api.minimaxi.com/v1/audio/transcriptions
MINIMAX_MODEL=MiniMax-M2.7-highspeed
MINIMAX_ASR_MODEL=speech-01

ASR_PROVIDER=local
LOCAL_ASR_MODEL_SIZE=base
LOCAL_ASR_DEVICE=cpu
LOCAL_ASR_COMPUTE_TYPE=int8
HF_ENDPOINT=https://hf-mirror.com

SECRET_KEY=meeting-assistant-secret-change-in-production
ACCESS_TOKEN_EXPIRE_DAYS=7
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=104857600
```

## 云服务器发布

仓库内已提供独立服务文件，不会修改 `zhouyuaninfo.com.cn` 或 `api.zhouyuaninfo.com.cn` 的 Nginx 配置：

- [deploy/meetingai-backend.service](deploy/meetingai-backend.service)
- [deploy/meetingai-frontend.service](deploy/meetingai-frontend.service)
- [deploy/publish.sh](deploy/publish.sh)

发布方式：

```bash
chmod +x deploy/publish.sh
./deploy/publish.sh
```

当前线上部署：

- 前端：`http://81.70.144.73:5174`
- 后端：`http://81.70.144.73:8989`

systemd 服务名：

- `meetingai-backend`
- `meetingai-frontend`

## 默认演示账号

当前内置演示账号：

- `admin / meeting2025`
- `test / test123`

## 当前边界

- 当前会议数据仍为轻量级内存方案，服务重启后不会保留运行时状态
- 上传文件会保留在 `uploads/` 目录，便于后续扩展持久化存储
- 当前正式工作流以会议录音处理为主，尚未接入持久化数据库和多租户管理
- 当前前端主流程聚焦会议音频，不建议把 README 中的能力理解为完整企业级会议平台

## 建议的下一步

- 接入数据库，持久化会议记录、转写结果、待办结果和纪要
- 增加用户管理和角色权限体系
- 增加导出能力，例如会议纪要 PDF / Word
- 增加运营数据面板和调用日志追踪
- 增加对象存储与音频归档能力
