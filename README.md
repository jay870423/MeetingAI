# MeetingAI 智能会议助手

MeetingAI 是一套独立运行的会议 AI 工具，支持会议录音上传、会议转写、待办提取和结构化纪要输出。当前仓库已经整理为前后端一体化结构，可直接部署到 `5174` 前端和 `8989` 后端，不依赖现有主站 Nginx 配置。

## 当前能力

- 账号登录鉴权
- 会议录音上传
- AI 转写会议内容
- 自动提取待办事项
- 自动生成会议纪要
- 独立端口部署
- 默认本地 ASR 转写，避免依赖不可用的远程语音接口

## 项目结构

```text
MeetingAI/
├─ app/                  # FastAPI 后端
├─ frontend/             # Vite + React 前端
├─ deploy/               # systemd 服务与发布脚本
├─ tests/                # 测试样例
├─ uploads/              # 上传目录（运行时生成）
├─ .env.example          # 环境变量示例
└─ requirements.txt
```

## 后端运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8989
```

说明：

- 默认 `ASR_PROVIDER=local`，后端会使用 `faster-whisper` 在本机完成转写
- 首次执行转写时会自动下载 Whisper 模型，第一次耗时会明显更长
- 若服务器无法直连 Hugging Face，建议在 `.env` 里配置 `HF_ENDPOINT=https://hf-mirror.com`
- 如需切回远程语音接口，可自行在 `.env` 中调整 `ASR_PROVIDER=minimax`

后端健康检查：

```bash
curl http://127.0.0.1:8989/health
```

## 前端运行

```bash
cd frontend
npm install
npm run dev
```

前端默认运行在：

- 本地开发：`http://127.0.0.1:5174`
- 生产静态资源：`frontend/dist`

前端会优先读取环境变量 `VITE_API_BASE_URL`，未配置时默认请求：

```text
http://当前主机:8989/api/v1
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

发布完成后：

- 前端：`http://81.70.144.73:5174`
- 后端：`http://81.70.144.73:8989`

## 说明

- 当前会议数据仍为轻量级内存方案，服务重启后不会保留运行时状态。
- 上传文件会保留在 `uploads/` 目录，便于后续扩展持久化存储。
- 默认演示账号仍支持：`admin / meeting2025`
