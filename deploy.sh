#!/bin/bash
# 部署脚本 - 将插件复制到远程服务器并重启 Gateway

set -e

REMOTE_USER="lucy"
REMOTE_HOST="192.168.0.184"
REMOTE_PATH="/home/lucy/projects/multimodal-rag"
GATEWAY_SERVICE="openclaw-gateway.service"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 检查参数：如果提供了文件路径，只同步该文件
SYNC_FILE="${1:-}"

if [ -n "$SYNC_FILE" ]; then
  echo -e "${YELLOW}快速同步单个文件: ${SYNC_FILE}${NC}"
  rsync -avz "$SYNC_FILE" ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"$SYNC_FILE"
  echo -e "${GREEN}✓ 文件同步完成${NC}"
  echo ""
  echo -e "${YELLOW}正在重启 Gateway 服务...${NC}"
  if ssh ${REMOTE_USER}@${REMOTE_HOST} "systemctl --user restart ${GATEWAY_SERVICE}" 2>/dev/null; then
    echo -e "${GREEN}✓ Gateway 服务已重启${NC}"
  else
    echo -e "${RED}⚠ 无法通过 systemctl 重启服务，请手动重启${NC}"
    echo "  运行: ssh ${REMOTE_USER}@${REMOTE_HOST} 'systemctl --user restart ${GATEWAY_SERVICE}'"
  fi
  exit 0
fi

echo -e "${YELLOW}正在同步文件到 ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}...${NC}"

rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  . ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/

echo -e "${GREEN}✓ 文件同步完成${NC}"

echo ""
echo -e "${YELLOW}正在安装依赖...${NC}"
ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_PATH} && npm install --omit=dev"

echo ""
echo -e "${YELLOW}正在重启 Gateway 服务...${NC}"
if ssh ${REMOTE_USER}@${REMOTE_HOST} "systemctl --user restart ${GATEWAY_SERVICE}" 2>/dev/null; then
  echo -e "${GREEN}✓ Gateway 服务已重启${NC}"
else
  echo -e "${RED}⚠ 无法通过 systemctl 重启服务，可能需要手动重启${NC}"
  echo "  尝试: ssh ${REMOTE_USER}@${REMOTE_HOST} 'systemctl --user restart ${GATEWAY_SERVICE}'"
fi

echo ""
echo -e "${YELLOW}等待服务启动（3秒）...${NC}"
sleep 3

echo ""
echo -e "${YELLOW}验证插件是否加载成功...${NC}"
# 使用 bash -lc 确保加载完整的 shell 环境（包括 PATH）
PLUGIN_STATUS=$(ssh ${REMOTE_USER}@${REMOTE_HOST} "bash -lc 'openclaw plugins list 2>/dev/null | grep multimodal-rag || echo \"not_found\"'" 2>/dev/null || echo "error")

if echo "$PLUGIN_STATUS" | grep -q "loaded"; then
  echo -e "${GREEN}✓ 插件已成功加载${NC}"
  echo "  状态: $PLUGIN_STATUS"
elif echo "$PLUGIN_STATUS" | grep -q "error\|not_found"; then
  echo -e "${YELLOW}⚠ 无法自动验证插件状态（可能是 PATH 问题）${NC}"
  echo "  请手动检查: ssh ${REMOTE_USER}@${REMOTE_HOST} 'bash -lc \"openclaw plugins list | grep multimodal-rag\"'"
else
  echo -e "${RED}⚠ 插件状态异常${NC}"
  echo "  状态: $PLUGIN_STATUS"
  echo "  请检查: ssh ${REMOTE_USER}@${REMOTE_HOST} 'bash -lc \"openclaw plugins list | grep multimodal-rag\"'"
fi

echo ""
echo -e "${GREEN}✓ 部署完成！${NC}"
echo ""
echo "下一步："
echo "  1. 查看插件状态: ssh ${REMOTE_USER}@${REMOTE_HOST} 'bash -lc \"openclaw plugins list | grep multimodal-rag\"'"
echo "  2. 查看媒体库统计: ssh ${REMOTE_USER}@${REMOTE_HOST} 'bash -lc \"openclaw multimodal-rag stats\"'"
echo "  3. 测试搜索: ssh ${REMOTE_USER}@${REMOTE_HOST} 'bash -lc \"openclaw multimodal-rag search 关键词\"'"
echo ""
echo "快速同步单个文件:"
echo "  ./deploy.sh src/tools.ts  # 只同步 tools.ts 文件"
