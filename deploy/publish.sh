#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/MeetingAI}"

echo "[1/6] 安装后端依赖"
cd "$APP_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "[2/6] 构建前端"
cd "$APP_DIR/frontend"
npm install
npm run build

echo "[3/6] 安装 systemd 服务"
cd "$APP_DIR"
sudo cp deploy/meetingai-backend.service /etc/systemd/system/meetingai-backend.service
sudo cp deploy/meetingai-frontend.service /etc/systemd/system/meetingai-frontend.service
sudo systemctl daemon-reload

echo "[4/6] 启动后端"
sudo systemctl enable meetingai-backend
sudo systemctl restart meetingai-backend

echo "[5/6] 启动前端"
sudo systemctl enable meetingai-frontend
sudo systemctl restart meetingai-frontend

echo "[6/6] 检查状态"
sudo systemctl --no-pager --full status meetingai-backend | sed -n '1,20p'
sudo systemctl --no-pager --full status meetingai-frontend | sed -n '1,20p'
