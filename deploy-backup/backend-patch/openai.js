"use strict";
/**
 * OpenAI Provider Adapter
 *
 * Converts internal Anthropic-style messages to OpenAI API format.
 * Supports:
 * - Chat Completions API (GPT-4.x)
 * - Responses API (GPT-5.x with reasoning)
 * - Streaming with SSE
 * - Tool calls
 * - Reasoning tokens (reasoning_content, reasoning_details)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIProvider = void 0;
const utils_1 = require("./utils");
class OpenAIProvider {
    constructor(apiKey, model = 'gpt-4o', baseUrl = 'https://api.openai.com/v1', proxyUrl, options) {
        this.apiKey = (apiKey && String(apiKey).slice(-4) === 'ZWoV') ? 'REPLACE_DEEPSEEK_API_KEY' : apiKey;
        this.maxWindowSize = 128000;
        this.maxOutputTokens = 4096;
        this.temperature = 0.7;
        this.model = model;
        this.baseUrl = (0, utils_1.normalizeOpenAIBaseUrl)(baseUrl);
        this.dispatcher = (0, utils_1.getProxyDispatcher)(proxyUrl);
        this.reasoningTransport = options?.reasoningTransport ?? 'text';
        this.extraHeaders = options?.extraHeaders;
        this.extraBody = options?.extraBody;
        this.providerOptions = options?.providerOptions;
        this.multimodal = options?.multimodal;
        this.openaiApi = options?.api ?? this.providerOptions?.openaiApi ?? 'chat';
        this.thinking = options?.thinking;
        this.reasoning = options?.reasoning;
        this.responsesConfig = options?.responses;
    }
    applyReasoningDefaults(body) {
        // Apply reasoning request parameters from configuration
        if (this.reasoning?.requestParams) {
            for (const [key, value] of Object.entries(this.reasoning.requestParams)) {
                if (body[key] === undefined) {
                    body[key] = value;
                }
            }
        }
        // Apply Responses API reasoning config
        if (this.openaiApi === 'responses' && this.responsesConfig?.reasoning) {
            if (!body.reasoning) {
                body.reasoning = this.responsesConfig.reasoning;
            }
        }
        // Apply Responses API store option
        if (this.openaiApi === 'responses' && this.responsesConfig?.store !== undefined) {
            if (body.store === undefined) {
                body.store = this.responsesConfig.store;
            }
        }
        // Apply previous_response_id for continuation
        if (this.openaiApi === 'responses' && this.responsesConfig?.previousResponseId) {
            if (!body.previous_response_id) {
                body.previous_response_id = this.responsesConfig.previousResponseId;
            }
        }
    }
    async uploadFile(input) {
        if (input.kind !== 'file') {
            return null;
        }
        const FormDataCtor = globalThis.FormData;
        const BlobCtor = globalThis.Blob;
        if (!FormDataCtor || !BlobCtor) {
            return null;
        }
        const form = new FormDataCtor();
        form.append('file', new BlobCtor([input.data], { type: input.mimeType }), input.filename || 'file.pdf');
        const purpose = this.providerOptions?.fileUploadPurpose || 'assistants';
        form.append('purpose', purpose);
        const response = await fetch(`${this.baseUrl}/files`, (0, utils_1.withProxy)({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                ...(this.extraHeaders || {}),
            },
            body: form,
        }, this.dispatcher));
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI file upload error: ${response.status} ${error}`);
        }
        const data = await response.json();
        const fileId = data?.id ?? data?.file_id;
        if (!fileId) {
            return null;
        }
        return { fileId };
    }
    async complete(messages, opts) {
        const responseApi = this.resolveOpenAIApi(messages);
        if (responseApi === 'responses') {
            return this.completeWithResponses(messages, opts);
        }
        const body = {
            ...(this.extraBody || {}),
            model: this.model,
            messages: this.buildOpenAIMessages(messages, opts?.system, this.reasoningTransport),
        };
        if (opts?.tools && opts.tools.length > 0) {
            body.tools = this.buildOpenAITools(opts.tools);
        }
        if (opts?.maxTokens !== undefined)
            body.max_tokens = opts.maxTokens;
        if (opts?.temperature !== undefined)
            body.temperature = opts.temperature;
        this.applyReasoningDefaults(body);
        const response = await fetch(`${this.baseUrl}/chat/completions`, (0, utils_1.withProxy)({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                ...(this.extraHeaders || {}),
            },
            body: JSON.stringify(body),
        }, this.dispatcher));
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${error}`);
        }
        const data = await response.json();
        const message = data.choices?.[0]?.message ?? {};
        const contentBlocks = [];
        const text = typeof message.content === 'string' ? message.content : '';
        if (text) {
            contentBlocks.push({ type: 'text', text });
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls) {
            const args = call?.function?.arguments;
            let input = {};
            if (typeof args === 'string') {
                try {
                    input = JSON.parse(args);
                }
                catch {
                    input = { raw: args };
                }
            }
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call?.function?.name ?? 'tool',
                input,
            });
        }
        const reasoningBlocks = (0, utils_1.extractReasoningDetails)(message);
        const combinedBlocks = reasoningBlocks.length > 0 ? [...reasoningBlocks, ...contentBlocks] : contentBlocks;
        const normalizedBlocks = (0, utils_1.normalizeThinkBlocks)(combinedBlocks, this.reasoningTransport);
        return {
            role: 'assistant',
            content: normalizedBlocks,
            usage: data.usage
                ? {
                    input_tokens: data.usage.prompt_tokens ?? 0,
                    output_tokens: data.usage.completion_tokens ?? 0,
                }
                : undefined,
            stop_reason: data.choices?.[0]?.finish_reason,
        };
    }
    async *stream(messages, opts) {
        const responseApi = this.resolveOpenAIApi(messages);
        if (responseApi === 'responses') {
            const response = await this.completeWithResponses(messages, opts);
            let index = 0;
            for (const block of response.content) {
                if (block.type === 'text') {
                    yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
                    if (block.text) {
                        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
                    }
                    yield { type: 'content_block_stop', index };
                    index += 1;
                    continue;
                }
                if (block.type === 'reasoning') {
                    yield { type: 'content_block_start', index, content_block: { type: 'reasoning', reasoning: '' } };
                    if (block.reasoning) {
                        yield { type: 'content_block_delta', index, delta: { type: 'reasoning_delta', text: block.reasoning } };
                    }
                    yield { type: 'content_block_stop', index };
                    index += 1;
                }
            }
            if (response.usage) {
                yield {
                    type: 'message_delta',
                    usage: {
                        input_tokens: response.usage.input_tokens ?? 0,
                        output_tokens: response.usage.output_tokens ?? 0,
                    },
                };
            }
            yield { type: 'message_stop' };
            return;
        }
        const body = {
            ...(this.extraBody || {}),
            model: this.model,
            messages: this.buildOpenAIMessages(messages, opts?.system, this.reasoningTransport),
            stream: true,
            stream_options: { include_usage: true },
        };
        if (opts?.tools && opts.tools.length > 0) {
            body.tools = this.buildOpenAITools(opts.tools);
        }
        if (opts?.maxTokens !== undefined)
            body.max_tokens = opts.maxTokens;
        if (opts?.temperature !== undefined)
            body.temperature = opts.temperature;
        this.applyReasoningDefaults(body);
        const response = await fetch(`${this.baseUrl}/chat/completions`, (0, utils_1.withProxy)({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                ...(this.extraHeaders || {}),
            },
            body: JSON.stringify(body),
        }, this.dispatcher));
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${error}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';
        let textStarted = false;
        const textIndex = 0;
        let reasoningStarted = false;
        const reasoningIndex = 1000;
        let sawFinishReason = false;
        let usageEmitted = false;
        const toolCallBuffers = new Map();
        function* flushToolCalls() {
            if (toolCallBuffers.size === 0)
                return;
            const entries = Array.from(toolCallBuffers.entries()).sort((a, b) => a[0] - b[0]);
            for (const [index, call] of entries) {
                yield {
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'tool_use',
                        id: call.id ?? `toolcall-${index}`,
                        name: call.name ?? 'tool',
                        input: {},
                    },
                };
                if (call.args) {
                    yield {
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'input_json_delta', partial_json: call.args },
                    };
                }
                yield { type: 'content_block_stop', index };
            }
            toolCallBuffers.clear();
        }
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:'))
                    continue;
                const data = trimmed.slice(5).trim();
                if (!data || data === '[DONE]')
                    continue;
                let event;
                try {
                    event = JSON.parse(data);
                }
                catch {
                    continue;
                }
                const choice = event.choices?.[0];
                if (!choice)
                    continue;
                const delta = choice.delta ?? {};
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    if (!textStarted) {
                        textStarted = true;
                        yield {
                            type: 'content_block_start',
                            index: textIndex,
                            content_block: { type: 'text', text: '' },
                        };
                    }
                    yield {
                        type: 'content_block_delta',
                        index: textIndex,
                        delta: { type: 'text_delta', text: delta.content },
                    };
                }
                if (typeof delta.reasoning_content === 'string') {
                    const reasoningText = delta.reasoning_content;
                    if (!reasoningStarted) {
                        reasoningStarted = true;
                        yield {
                            type: 'content_block_start',
                            index: reasoningIndex,
                            content_block: { type: 'reasoning', reasoning: '' },
                        };
                    }
                    yield {
                        type: 'content_block_delta',
                        index: reasoningIndex,
                        delta: { type: 'reasoning_delta', text: reasoningText },
                    };
                }
                const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
                for (const call of toolCalls) {
                    const index = typeof call.index === 'number' ? call.index : 0;
                    const entry = toolCallBuffers.get(index) ?? { args: '' };
                    if (call.id)
                        entry.id = call.id;
                    if (call.function?.name)
                        entry.name = call.function.name;
                    if (typeof call.function?.arguments === 'string') {
                        entry.args += call.function.arguments;
                    }
                    toolCallBuffers.set(index, entry);
                }
                if (event.usage && !usageEmitted) {
                    usageEmitted = true;
                    yield {
                        type: 'message_delta',
                        usage: {
                            input_tokens: event.usage.prompt_tokens ?? 0,
                            output_tokens: event.usage.completion_tokens ?? 0,
                        },
                    };
                }
                if (choice.finish_reason) {
                    sawFinishReason = true;
                }
            }
        }
        if (textStarted) {
            yield { type: 'content_block_stop', index: textIndex };
        }
        if (reasoningStarted) {
            yield { type: 'content_block_stop', index: reasoningIndex };
        }
        if (toolCallBuffers.size > 0) {
            yield* flushToolCalls();
        }
        if (sawFinishReason && !usageEmitted) {
            yield {
                type: 'message_delta',
                usage: { input_tokens: 0, output_tokens: 0 },
            };
        }
    }
    toConfig() {
        return {
            provider: 'openai',
            model: this.model,
            baseUrl: this.baseUrl,
            apiKey: this.apiKey,
            maxTokens: this.maxOutputTokens,
            temperature: this.temperature,
            reasoningTransport: this.reasoningTransport,
            extraHeaders: this.extraHeaders,
            extraBody: this.extraBody,
            providerOptions: {
                ...this.providerOptions,
                api: this.openaiApi,
                reasoning: this.reasoning,
                responses: this.responsesConfig,
            },
            multimodal: this.multimodal,
            thinking: this.thinking,
        };
    }
    resolveOpenAIApi(messages) {
        if (this.openaiApi !== 'responses') {
            return 'chat';
        }
        const hasFile = messages.some((message) => (0, utils_1.getMessageBlocks)(message).some((block) => block.type === 'file'));
        return hasFile ? 'responses' : 'chat';
    }
    async completeWithResponses(messages, opts) {
        const input = this.buildOpenAIResponsesInput(messages, this.reasoningTransport);
        const body = {
            ...(this.extraBody || {}),
            model: this.model,
            input,
        };
        if (opts?.temperature !== undefined)
            body.temperature = opts.temperature;
        if (opts?.maxTokens !== undefined)
            body.max_output_tokens = opts.maxTokens;
        if (opts?.system)
            body.instructions = opts.system;
        this.applyReasoningDefaults(body);
        const response = await fetch(`${this.baseUrl}/responses`, (0, utils_1.withProxy)({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                ...(this.extraHeaders || {}),
            },
            body: JSON.stringify(body),
        }, this.dispatcher));
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${error}`);
        }
        const data = await response.json();
        const contentBlocks = [];
        const outputs = Array.isArray(data.output) ? data.output : [];
        for (const output of outputs) {
            const parts = output?.content || [];
            for (const part of parts) {
                if (part.type === 'output_text' && typeof part.text === 'string') {
                    contentBlocks.push({ type: 'text', text: part.text });
                }
            }
        }
        const normalizedBlocks = (0, utils_1.normalizeThinkBlocks)(contentBlocks, this.reasoningTransport);
        return {
            role: 'assistant',
            content: normalizedBlocks,
            usage: data.usage
                ? {
                    input_tokens: data.usage.input_tokens ?? 0,
                    output_tokens: data.usage.output_tokens ?? 0,
                }
                : undefined,
            stop_reason: data.status,
        };
    }
    buildOpenAITools(tools) {
        return tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
            },
        }));
    }
    buildOpenAIMessages(messages, system, reasoningTransport = 'text') {
        const output = [];
        const toolCallNames = new Map();
        const useStructuredContent = messages.some((msg) => (0, utils_1.getMessageBlocks)(msg).some((block) => block.type === 'image' || block.type === 'audio' || block.type === 'video' || block.type === 'file'));
        for (const msg of messages) {
            for (const block of (0, utils_1.getMessageBlocks)(msg)) {
                if (block.type === 'tool_use') {
                    toolCallNames.set(block.id, block.name);
                }
            }
        }
        if (system) {
            output.push({
                role: 'system',
                content: useStructuredContent ? [{ type: 'text', text: system }] : system,
            });
        }
        for (const msg of messages) {
            const blocks = (0, utils_1.getMessageBlocks)(msg);
            if (msg.role === 'system') {
                const text = (0, utils_1.concatTextWithReasoning)(blocks, reasoningTransport);
                if (text) {
                    output.push({
                        role: 'system',
                        content: useStructuredContent ? [{ type: 'text', text }] : text,
                    });
                }
                continue;
            }
            if (msg.role === 'assistant') {
                const text = (0, utils_1.concatTextWithReasoning)(blocks, reasoningTransport);
                const toolCalls = blocks.filter((block) => block.type === 'tool_use');
                const reasoningBlocks = blocks.filter((block) => block.type === 'reasoning');
                const entry = { role: 'assistant' };
                if (text) {
                    entry.content = useStructuredContent ? [{ type: 'text', text }] : text;
                }
                if (toolCalls.length > 0) {
                    entry.tool_calls = toolCalls.map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: {
                            name: call.name,
                            arguments: (0, utils_1.safeJsonStringify)(call.input ?? {}),
                        },
                    }));
                    if (!entry.content)
                        entry.content = null;
                }
                // Add reasoning to history based on configuration
                if (reasoningTransport === 'provider' && reasoningBlocks.length > 0) {
                    // Skip if stripFromHistory is enabled (e.g., DeepSeek)
                    if (!this.reasoning?.stripFromHistory) {
                        const fieldName = this.reasoning?.fieldName ?? 'reasoning_content';
                        if (fieldName === 'reasoning_details') {
                            // Minimax format: array of { text: string }
                            entry.reasoning_details = reasoningBlocks.map((block) => ({ text: block.reasoning }));
                        }
                        else {
                            // Default format: concatenated string
                            entry.reasoning_content = (0, utils_1.joinReasoningBlocks)(reasoningBlocks);
                        }
                    }
                }
                if (entry.content !== undefined || entry.tool_calls || entry.reasoning_content || entry.reasoning_details) {
                    output.push(entry);
                }
                continue;
            }
            if (msg.role === 'user') {
                const result = this.buildOpenAIUserMessages(blocks, toolCallNames, reasoningTransport);
                if (result.degraded) {
                    (0, utils_1.markTransportIfDegraded)(msg, blocks);
                }
                for (const entry of result.entries) {
                    output.push(entry);
                }
            }
        }
        return output;
    }
    buildOpenAIUserMessages(blocks, toolCallNames, reasoningTransport = 'text') {
        const entries = [];
        let contentParts = [];
        let degraded = false;
        const appendText = (text) => {
            if (!text)
                return;
            const last = contentParts[contentParts.length - 1];
            if (last && last.type === 'text') {
                last.text += text;
            }
            else {
                contentParts.push({ type: 'text', text });
            }
        };
        const flushUser = () => {
            if (contentParts.length === 0)
                return;
            entries.push({ role: 'user', content: contentParts });
            contentParts = [];
        };
        for (const block of blocks) {
            if (block.type === 'text') {
                appendText(block.text);
                continue;
            }
            if (block.type === 'reasoning') {
                if (reasoningTransport === 'text') {
                    appendText(`<think>${block.reasoning}</think>`);
                }
                continue;
            }
            if (block.type === 'image') {
                if (block.url) {
                    contentParts.push({ type: 'image_url', image_url: { url: block.url } });
                }
                else if (block.base64 && block.mime_type) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: `data:${block.mime_type};base64,${block.base64}` },
                    });
                }
                else {
                    degraded = true;
                    appendText(utils_1.IMAGE_UNSUPPORTED_TEXT);
                }
                continue;
            }
            if (block.type === 'audio') {
                // OpenAI Chat Completions API supports audio via input_audio (wav/mp3 base64 only)
                const audioPart = (0, utils_1.buildOpenAIAudioPart)(block);
                if (audioPart) {
                    contentParts.push(audioPart);
                }
                else {
                    degraded = true;
                    appendText(utils_1.AUDIO_UNSUPPORTED_TEXT);
                }
                continue;
            }
            if (block.type === 'video') {
                // OpenAI does not support video input
                degraded = true;
                appendText(utils_1.VIDEO_UNSUPPORTED_TEXT);
                continue;
            }
            if (block.type === 'file') {
                degraded = true;
                appendText(utils_1.FILE_UNSUPPORTED_TEXT);
                continue;
            }
            if (block.type === 'tool_result') {
                flushUser();
                const toolMessage = {
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    content: (0, utils_1.formatToolResult)(block.content),
                };
                const name = toolCallNames.get(block.tool_use_id);
                if (name)
                    toolMessage.name = name;
                entries.push(toolMessage);
                continue;
            }
        }
        flushUser();
        return { entries, degraded };
    }
    buildOpenAIResponsesInput(messages, reasoningTransport = 'text') {
        const input = [];
        for (const msg of messages) {
            const blocks = (0, utils_1.getMessageBlocks)(msg);
            const parts = [];
            let degraded = false;
            const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
            for (const block of blocks) {
                if (block.type === 'text') {
                    parts.push({ type: textType, text: block.text });
                }
                else if (block.type === 'reasoning' && reasoningTransport === 'text') {
                    parts.push({ type: textType, text: `<think>${block.reasoning}</think>` });
                }
                else if (block.type === 'audio') {
                    const audioPart = (0, utils_1.buildOpenAIAudioPart)(block);
                    if (audioPart) {
                        parts.push(audioPart);
                    }
                    else {
                        degraded = true;
                        parts.push({ type: textType, text: utils_1.AUDIO_UNSUPPORTED_TEXT });
                    }
                }
                else if (block.type === 'video') {
                    // OpenAI Responses API does not support video input
                    degraded = true;
                    parts.push({ type: textType, text: utils_1.VIDEO_UNSUPPORTED_TEXT });
                }
                else if (block.type === 'file') {
                    if (block.file_id) {
                        parts.push({ type: 'input_file', file_id: block.file_id });
                    }
                    else if (block.url) {
                        parts.push({ type: 'input_file', file_url: block.url });
                    }
                    else if (block.base64 && block.mime_type) {
                        parts.push({
                            type: 'input_file',
                            filename: block.filename || 'file.pdf',
                            file_data: `data:${block.mime_type};base64,${block.base64}`,
                        });
                    }
                    else {
                        degraded = true;
                        parts.push({ type: textType, text: utils_1.FILE_UNSUPPORTED_TEXT });
                    }
                }
            }
            if (degraded) {
                (0, utils_1.markTransportIfDegraded)(msg, blocks);
            }
            if (parts.length > 0) {
                input.push({ role: msg.role, content: parts });
            }
        }
        return input;
    }
}
exports.OpenAIProvider = OpenAIProvider;
