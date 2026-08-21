# 拾光演绎 AI Time - 本地创作者工作台镜像
# 基于上游原始 web 镜像，保留其 nginx 反向代理配置（/api/media-proxy、/api/new-api、
# /api/antsk-proxy、/api/cutos、/api/agent）。
# 前端替换为本地补丁版静态资源：解锁自定义模型、隐藏商业版入口，
# 预置 DeepSeek / 通义千问 / 百炼 / 万相（走本地 dashscope-relay 转接），key 由创作者在界面自行填写。
FROM shiguang-director:web-3.4.0-original

COPY deploy-backup/web-3.4.0-custom-v14/ /usr/share/nginx/html/

# 启用补丁版 bundle：把模板中的占位 API Key 替换为本地构建参数注入的真实 Key
# （Key 通过 --build-arg-file 传入，不写入镜像定义与 git；不传则置空，由创作者在界面填写），
# 同时将旧品牌字样统一为「拾光演绎 AI Time」。
ARG DEEPSEEK_KEY=
ARG IMG_KEY=
ARG AUD_KEY=

RUN sed -e "s|REPLACE_DEEPSEEK_API_KEY|${DEEPSEEK_KEY}|g" \
        -e "s|REPLACE_QWEN_IMAGE_API_KEY|${IMG_KEY}|g" \
        -e "s|REPLACE_DASHSCOPE_AUDIO_API_KEY|${AUD_KEY}|g" \
        -e 's/拾光导演/拾光演绎/g' \
        -e 's/AI Director/AI Time/g' \
        /usr/share/nginx/html/assets/index-D9jX3f3S.template.js \
        > /usr/share/nginx/html/assets/index-D9jX3f3S.js

EXPOSE 80
