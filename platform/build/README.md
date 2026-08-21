# 本地镜像构建说明

`platform/docker-compose.yaml` 引用 5 个本地镜像（`shiguang-director:*`），首次部署时需要先准备镜像。

## 准备步骤

```bash
# 1. 从阿里云镜像仓库拉取上游基础镜像
docker pull registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:web-3.4.0
docker pull registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:media-3.4.0
docker pull registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:newapi-3.4.0
docker pull registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:cutos-3.4.0

# 2. 重命名为 compose 需要的镜像名
docker tag registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:web-3.4.0   shiguang-director:web-3.4.0-original
docker tag registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:media-3.4.0 shiguang-director:media-3.4.0
docker tag registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:newapi-3.4.0 shiguang-director:newapi-3.4.0
docker tag registry.cn-hangzhou.aliyuncs.com/tree456/bigbanana-ai-director:cutos-3.4.0 shiguang-director:cutos-3.4.0

# 3. 构建补丁版前端（基于 web-3.4.0-original，覆盖本地解锁版静态资源）
# 如需把真实模型 Key 内嵌到镜像（可选，不填则由创作者在界面自行配置）：
#   在仓库根目录准备 KEYS.local.txt（已被 .gitignore 排除，严禁提交），格式：
#     DEEPSEEK_KEY=sk-xxx
#     IMG_KEY=sk-xxx
#     AUD_KEY=sk-xxx
#     VID_KEY=sk-xxx
docker build --build-arg-file KEYS.local.txt -f platform/build/web-v26/Dockerfile -t shiguang-director:web-v26 .

# 4. 构建百炼转接服务
docker build -t shiguang-director:dashscope-relay-1.5 platform/relay
```

## 启动与停止

```bash
cd platform
docker compose up -d      # 启动
docker compose down       # 停止
```

启动后访问 <http://localhost:3005>。

## 功能配置（可选）

- 界面中的模型调用需要真实 API Key（DeepSeek / 阿里云百炼等），在「模型配置」页填写后即存入浏览器本地。
- `docker-compose.yaml` 中 `cutos-api` 的 `DASHSCOPE_API_KEY` 为占位值，生成语音/视频前请替换为真实 key 并重启该容器。
- 若需启用 `deploy-backup/backend-patch`（DeepSeek key 纠错补丁），先替换文件内 `REPLACE_DEEPSEEK_API_KEY` 为真实 key，再执行：

  ```bash
  docker cp deploy-backup/backend-patch/openai.js shiguang-director-cutos-api:/app/node_modules/@shareai-lab/kode-sdk/dist/infra/providers/openai.js
  docker restart shiguang-director-cutos-api
  ```
