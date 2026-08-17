# DeepSeek Key 后端补丁说明
修改文件: node_modules/@shareai-lab/kode-sdk/dist/infra/providers/openai.js（在 cutos-api 容器内）
修改内容: constructor 里 apiKey 结尾为 ZWoV 时自动替换为有效 key:
  REPLACE_DEEPSEEK_API_KEY
作用: 前端(浏览器)即使仍持有旧的无效 key，后端调用 DeepSeek 时也会纠正，不再 401。
重新应用方法:
  docker cp deploy-backup\backend-patch\openai.js shiguang-director-cutos-api:/app/node_modules/@shareai-lab/kode-sdk/dist/infra/providers/openai.js
  docker restart shiguang-director-cutos-api
