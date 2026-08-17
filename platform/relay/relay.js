'use strict';

/*
 * DashScope (阿里云百炼) OpenAI 兼容转接服务
 * ----------------------------------------------------------------
 * 百炼的生图 / 语音合成只有原生(异步)接口，而 拾光导演 前端走的是
 * OpenAI 兼容协议。本服务把两类请求翻译过来：
 *
 *   POST /v1/images/generations  -> 百炼原生 text2image（异步任务+轮询）
 *   POST /v1/audio/speech        -> 百炼原生 multimodal-generation（TTS）
 *
 * 浏览器把用户的百炼 API Key 放在 Authorization 头里传进来，本服务原样
 * 转发给百炼，不在服务端保存任何密钥。
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.RELAY_PORT || '8790', 10);
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';

const IMAGE_SYNTHESIS_PATH = '/api/v1/services/aigc/text2image/image-synthesis';
const TASK_PATH = '/api/v1/tasks/';
const TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const WAN_VIDEO_SYNTH_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';

const IMAGE_TIMEOUT_MS = 180000;
const AUDIO_TIMEOUT_MS = 120000;
const WAN_VIDEO_DEFAULT_MODEL = 'wan2.5-t2v-preview';
const WAN_I2V_DEFAULT_MODEL = 'wan2.5-i2v-preview';

const videoCache = new Map();

const QWEN_TTS_VOICES = new Set([
  'Cherry', 'Ethan', 'Harry', 'Lucy', 'Serena', 'Claude',
  'Azure', 'Ada', 'Bella', 'Nova', 'Aria', 'Orion', 'River',
  'Daniel', 'Liam', 'Emma', 'Charlotte', 'Amelia', 'Sophia',
  'Isabella', 'Mia', 'Evelyn', 'Harper', 'Camila', 'Gianna',
  'Abigail', 'Luna', 'Ella', 'Elizabeth', 'Sofia', 'Lola',
]);

const IMAGE_SIZES = [
  '1664*928', '928*1664',
  '1472*1104', '1104*1472',
  '1328*1328', '1024*1024',
];

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, X-Requested-With, X-DashScope-Async'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  corsHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function httpsRequest(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const data = [];
      res.on('data', (c) => data.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(data),
        })
      );
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 60000, () => {
      req.destroy(new Error('upstream timeout'));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

function postJson(path, auth, payload, timeoutMs, asyncMode) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    Authorization: 'Bearer ' + auth,
  };
  if (asyncMode) headers['X-DashScope-Async'] = 'enable';
  return httpsRequest(
    {
      hostname: DASHSCOPE_HOST,
      path,
      method: 'POST',
      headers,
    },
    body,
    timeoutMs
  );
}

function getJson(path, auth, timeoutMs) {
  return httpsRequest(
    {
      hostname: DASHSCOPE_HOST,
      path,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + auth,
      },
    },
    null,
    timeoutMs
  );
}

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseOpenAiSize(size) {
  if (!size) return null;
  const m = /^(\d+)[x*](\d+)$/i.exec(String(size).trim());
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function toDashScopeSize(size) {
  const parsed = parseOpenAiSize(size);
  if (!parsed) return '1024*1024';
  const exact = parsed.w + '*' + parsed.h;
  if (IMAGE_SIZES.indexOf(exact) !== -1) return exact;
  const ratio = parsed.w / parsed.h;
  if (ratio >= 1.7) return '1664*928';
  if (ratio >= 1.25) return '1472*1104';
  if (ratio <= 0.6) return '928*1664';
  if (ratio <= 0.8) return '1104*1472';
  return '1328*1328';
}

async function downloadToBase64(url, timeoutMs) {
  const target = new URL(url);
  const res = await httpsRequest(
    {
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Accept: '*/*' },
    },
    null,
    timeoutMs
  );
  if (res.status !== 200) {
    throw new Error('download failed with HTTP ' + res.status);
  }
  return res.body.toString('base64');
}

async function createImageTask(auth, body) {
  const size = toDashScopeSize(body.size);
  const n = Math.max(1, Math.min(4, parseInt(body.n, 10) || 1));
  const payload = {
    model: body.model || 'qwen-image',
    input: { prompt: String(body.prompt || '') },
    parameters: { size, n },
  };
  const res = await postJson(IMAGE_SYNTHESIS_PATH, auth, payload, 60000, true);
  const parsed = safeJson(res.body);
  if (res.status !== 200) {
    throw apiError(res.status, parsed);
  }
  const taskId = parsed && parsed.output && parsed.output.task_id;
  if (!taskId) throw new Error('创建生图任务失败：未返回 task_id');
  return taskId;
}

async function pollImageTask(auth, taskId) {
  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await getJson(TASK_PATH + taskId, auth, 30000);
    const parsed = safeJson(res.body);
    const status = parsed && parsed.output && parsed.output.task_status;
    if (status === 'SUCCEEDED') {
      const results = (parsed.output.results || []).filter((r) => r && r.url);
      if (results.length === 0) {
        throw new Error('生图任务已完成，但未返回图片地址');
      }
      return results;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const code = parsed && parsed.output && parsed.output.code;
      const message = parsed && parsed.output && parsed.output.message;
      throw new Error('生图任务失败：' + (message || code || status));
    }
    await sleep(2000);
  }
  throw new Error('生图任务超时');
}

async function handleImageGeneration(req, res) {
  const auth = bearerToken(req);
  if (!auth) return sendJson(res, 401, { error: { message: '缺少 API Key（Authorization: Bearer ...）' } });
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  let body;
  if (/multipart\/form-data/i.test(contentType)) {
    const fields = parseMultipartTextFields(raw, contentType);
    if (!fields) return sendJson(res, 400, { error: { message: '无法解析 multipart 表单' } });
    body = {
      model: fields.model,
      prompt: fields.prompt,
      size: fields.size,
      quality: fields.quality,
      output_format: fields.output_format,
      output_compression: fields.output_compression,
      n: fields.n,
    };
    console.log('[image] multipart 请求：忽略参考图文件，按纯文本降级生成');
  } else {
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
    }
  }
  if (!body.prompt) {
    return sendJson(res, 400, { error: { message: '缺少 prompt' } });
  }
  try {
    const taskId = await createImageTask(auth, body);
    const results = await pollImageTask(auth, taskId);
    const data = [];
    for (const r of results) {
      const b64 = await downloadToBase64(r.url, 60000);
      data.push({ b64_json: b64, revised_prompt: body.prompt });
    }
    return sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data });
  } catch (e) {
    return sendJson(res, 502, { error: { message: e.message || String(e) } });
  }
}

async function generateSpeech(auth, body) {
  const model = body.model || 'qwen3-tts-flash';
  const voice = QWEN_TTS_VOICES.has(String(body.voice || '')) ? String(body.voice) : 'Cherry';
  const format = String(body.response_format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const payload = {
    model,
    input: { text: String(body.input || '') },
    parameters: {
      voice,
      format,
      sample_rate: 24000,
      text_type: 'plain',
      volume: 50,
      speed: 1.0,
    },
  };
  const res = await postJson(TTS_PATH, auth, payload, AUDIO_TIMEOUT_MS, false);
  const parsed = safeJson(res.body);
  if (res.status !== 200) {
    throw apiError(res.status, parsed);
  }
  const audio = parsed && parsed.output && parsed.output.audio;
  if (!audio) throw new Error('语音合成未返回音频');
  if (audio.data) return Buffer.from(audio.data, 'base64');
  if (!audio.url) throw new Error('语音合成未返回音频地址');
  const deadline = Date.now() + 60000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const target = new URL(audio.url);
      const r = await httpsRequest(
        {
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          headers: { Accept: '*/*' },
        },
        null,
        30000
      );
      if (r.status === 200 && r.body.length > 0) return r.body;
      lastErr = new Error('音频尚未就绪（HTTP ' + r.status + '）');
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500);
  }
  throw lastErr || new Error('获取音频文件超时');
}

async function handleSpeech(req, res) {
  const auth = bearerToken(req);
  if (!auth) return sendJson(res, 401, { error: { message: '缺少 API Key（Authorization: Bearer ...）' } });
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
  }
  if (!body.input) {
    return sendJson(res, 400, { error: { message: '缺少 input 文本' } });
  }
  try {
    const audioBuf = await generateSpeech(auth, body);
    const fmt = String(body.response_format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
    // 返回 JSON { audio: base64 }，前端会拼成 data:audio/mpeg;base64,...
    return sendJson(res, 200, {
      audio: audioBuf.toString('base64'),
      format: fmt,
      model: body.model || 'qwen3-tts-flash',
    });
  } catch (e) {
    return sendJson(res, 502, { error: { message: e.message || String(e) } });
  }
}

function ratioToWanSize(ratio) {
  const r = String(ratio || '16:9');
  if (r === '9:16') return '720*1280';
  if (r === '1:1') return '960*960';
  return '1280*720';
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textItem = content.find((c) => c && c.type === 'text' && c.text);
    return textItem ? String(textItem.text) : '';
  }
  if (content && typeof content === 'object' && content.text) return String(content.text);
  return '';
}

// 极简 multipart/form-data 文本字段解析（网页端带参考图时按纯文本降级生图）
function parseMultipartTextFields(raw, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const text = raw.toString('binary');
  const fields = {};
  const parts = text.split(boundary);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const nameM = /name="([^"]+)"/i.exec(headers);
    if (!nameM) continue;
    if (/filename="[^"]*"/i.test(headers)) continue; // 跳过参考图文件
    fields[nameM[1]] = part.slice(headerEnd + 4).replace(/\r?\n$/, '');
  }
  return fields;
}

async function createWanVideoTask(auth, body) {
  const content = body.content;
  const contentArr = Array.isArray(content) ? content : [];
  const textItem = contentArr.find((c) => c && c.type === 'text');
  const imgItem = contentArr.find((c) => c && c.type === 'image_url');
  const prompt = textItem ? String(textItem.text) : typeof content === 'string' ? content : extractTextContent(content);
  const imgUrl = imgItem && imgItem.image_url && imgItem.image_url.url ? String(imgItem.image_url.url) : '';
  const isI2V = !!imgUrl;
  const model = body.model || (isI2V ? WAN_I2V_DEFAULT_MODEL : WAN_VIDEO_DEFAULT_MODEL);
  if (isI2V) {
    console.log('[video] 图生视频（首帧模式）：使用 ' + model);
  }
  if (!prompt) throw new Error('缺少视频提示词 content');
  const size = ratioToWanSize(body.ratio);
  let duration = parseInt(body.duration, 10);
  if (duration !== 5 && duration !== 10) duration = 5;
  const payload = {
    model,
    input: isI2V ? { prompt, img_url: imgUrl } : { prompt },
    parameters: { size, duration },
  };
  const res = await postJson(WAN_VIDEO_SYNTH_PATH, auth, payload, 60000, true);
  const parsed = safeJson(res.body);
  if (res.status !== 200) throw apiError(res.status, parsed);
  const taskId = parsed && parsed.output && parsed.output.task_id;
  if (!taskId) throw new Error('创建视频任务失败：未返回 task_id');
  return taskId;
}

async function queryWanVideoTask(auth, taskId) {
  const res = await getJson(TASK_PATH + taskId, auth, 30000);
  const parsed = safeJson(res.body);
  const st = parsed && parsed.output && parsed.output.task_status;
  const statusMap = {
    PENDING: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELED: 'canceled',
    UNKNOWN: 'unknown',
  };
  const status = statusMap[st] || 'queued';
  let videoUrl = '';
  if (st === 'SUCCEEDED') {
    const rawUrl =
      (parsed.output && parsed.output.video_url) ||
      (parsed.output && parsed.output.results && parsed.output.results[0] && parsed.output.results[0].url) ||
      '';
    if (!rawUrl) throw new Error('视频任务已完成，但未返回视频地址');
    // 服务端下载视频，改用本地地址返回，绕开 OSS 签名 URL 在浏览器/代理中转时的签名破坏问题
    let cached = videoCache.get(taskId);
    if (!cached) {
      const buf = await downloadUrl(rawUrl, 120000);
      cached = { buf, type: 'video/mp4' };
      videoCache.set(taskId, cached);
    }
    videoUrl = 'http://localhost:8790/video/' + taskId + '.mp4';
  }
  return { id: taskId, status, content: videoUrl ? { video_url: videoUrl } : {} };
}

async function downloadUrl(url, timeoutMs) {
  const target = new URL(url);
  const res = await httpsRequest(
    {
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': 'dashscope-relay/1.1' },
    },
    null,
    timeoutMs
  );
  if (res.status !== 200) {
    throw new Error('视频下载失败（HTTP ' + res.status + '）');
  }
  return res.body;
}

function handleVideoFile(req, res, fileName) {
  const m = /^([0-9a-f-]+)\.mp4$/i.exec(fileName);
  if (!m) return sendJson(res, 404, { error: { message: 'not found' } });
  const cached = videoCache.get(m[1]);
  if (!cached) return sendJson(res, 404, { error: { message: '视频已过期，请重新生成' } });
  corsHeaders(res);
  res.writeHead(200, {
    'Content-Type': cached.type,
    'Content-Length': cached.buf.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  res.end(cached.buf);
}

async function handleVideoTaskCreate(req, res) {
  const auth = bearerToken(req);
  if (!auth) return sendJson(res, 401, { error: { message: '缺少 API Key（Authorization: Bearer ...）' } });
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
  }
  try {
    const taskId = await createWanVideoTask(auth, body);
    return sendJson(res, 200, { id: taskId, data: { id: taskId, task_id: taskId } });
  } catch (e) {
    return sendJson(res, 502, { error: { message: e.message || String(e) } });
  }
}

async function handleVideoTaskQuery(req, res, taskId) {
  const auth = bearerToken(req);
  if (!auth) return sendJson(res, 401, { error: { message: '缺少 API Key（Authorization: Bearer ...）' } });
  try {
    const info = await queryWanVideoTask(auth, taskId);
    return sendJson(res, 200, info);
  } catch (e) {
    return sendJson(res, 502, { error: { message: e.message || String(e) } });
  }
}

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    return null;
  }
}

function apiError(status, parsed) {
  const m =
    (parsed && parsed.message) ||
    (parsed && parsed.error && parsed.error.message) ||
    '上游接口错误（HTTP ' + status + '）';
  return new Error(m);
}

const server = http.createServer(async (req, res) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }
    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits')
    ) {
      return await handleImageGeneration(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      return await handleSpeech(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/contents/generations/tasks') {
      return await handleVideoTaskCreate(req, res);
    }
    if (req.method === 'GET' && url.pathname.indexOf('/api/v3/contents/generations/tasks/') === 0) {
      const taskId = decodeURIComponent(url.pathname.slice('/api/v3/contents/generations/tasks/'.length));
      if (taskId) return await handleVideoTaskQuery(req, res, taskId);
    }
    if (req.method === 'GET' && url.pathname.indexOf('/video/') === 0) {
      return handleVideoFile(req, res, url.pathname.slice('/video/'.length));
    }
    return sendJson(res, 404, { error: { message: 'not found' } });
  } catch (e) {
    return sendJson(res, 500, { error: { message: e.message || String(e) } });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('dashscope-relay listening on 0.0.0.0:' + PORT);
});
