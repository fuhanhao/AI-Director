# 拾光演绎 AI Time - 本地工作台镜像（补丁版前端）
# 基于上游原始 web 镜像，保留其 nginx 反向代理配置（/api/media-proxy、/api/new-api、
# /api/antsk-proxy、/api/cutos、/api/agent），只替换为本地已解锁的补丁版前端静态资源。
FROM shiguang-director:web-3.4.0-original

COPY deploy-backup/web-3.4.0-custom-v14/ /usr/share/nginx/html/

# 品牌替换：把内置前端 bundle 中的旧品牌字样同步为「拾光演绎 AI Time」
RUN sed -i 's/拾光导演/拾光演绎/g; s/AI Director/AI Time/g' /usr/share/nginx/html/assets/index-D9jX3f3S.js

EXPOSE 80
