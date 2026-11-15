// Best-first live free-model aggregator for make.fun free-model-aggregator-02.
//
// One long-running server (Node 22, zero dependencies). It speaks the OpenAI
// Chat Completions API and the Anthropic Messages API on the front — JSON and
// server-sent events — and answers every prompt with a REAL completion from
// one of OpenRouter's fourteen free models, dialled through the grader's
// gateway on the trial's key. There is no simulated provider anywhere here.
//
// Routing: best-first from the brief's sealed quality table. The strongest
// model that meets a prompt's requirements serves it first (inkling-2-small,
// rating 1475, for plain / tools / streaming prompts; nemotron-3.5-super-vl,
// rating 1303, for JSON-mode prompts, since inkling does not do JSON mode).
// A refusal (429 / 5xx) fails over to the next strongest model that meets
// the requirements; a 403 demotes that model for the rest of the trial
// (OpenRouter gates some free models to agentic harnesses); a 401 means no
// provider key was pushed, so the server stops dialling at once. Every
// recovered refusal is reported on the response in the
// x-makefun-upstream-failures header, so the failover column can see it.
//
// Every choice is a function of the brief, the request and the gateway's
// answers so far: no wall clock and no unseeded randomness, so a replay
// leaves the same state export byte for byte. The upstream is always called
// non-streaming; this server renders the client's stream itself, which is
// the only way to guarantee the usage chunk a streamed answer needs.
//
// Usage:
//   node main.ts --list   print the catalog document and exit 0
//   node main.ts          serve a trial (the sandbox sets MAKEFUN_ENV_URL,
//                         MAKEFUN_PROMPT_FILE, MAKEFUN_TRIAL_SEED,
//                         OPENAI_BASE_URL and the trial's dummy keys)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
const FIXED_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
const MAX_UPSTREAM_ATTEMPTS = 12;

interface ModelRow {
  id: string;
  displayName: string;
  rating: number;
  contextLength: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

interface Requirements {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

// The fourteen free models, in the brief's order, as a fallback for a trial
// whose brief cannot be read. The live table always comes from the brief;
// this copy only keeps --list and the catalog working with no brief at all.
const FALLBACK_MODELS: ModelRow[] = [
  { id: 'openrouter/baidu/ernie-5.5-flash-preview:free', displayName: 'Baidu: ERNIE-5.5-Flash-Preview (free)', rating: 1150, contextLength: 1024000, tools: true, vision: false, json: true },
  { id: 'openrouter/cohere/north-mini-code:free', displayName: 'Cohere: North Mini Code (free)', rating: 1200, contextLength: 256000, tools: true, vision: false, json: false },
  { id: 'openrouter/dots-studio/dots-3-note-preview:free', displayName: 'Dots Studio: Dots3-Note Preview (free)', rating: 1150, contextLength: 512000, tools: true, vision: true, json: true },
  { id: 'openrouter/google/gemma-4-26b-a4b-it:free', displayName: 'Google: Gemma 4 26B A4B (free)', rating: 1150, contextLength: 262144, tools: true, vision: true, json: true },
  { id: 'openrouter/google/gemma-4-31b-it:free', displayName: 'Google: Gemma 4 31B (free)', rating: 1210, contextLength: 262144, tools: true, vision: true, json: true },
  { id: 'openrouter/inclusionai/ling-3.2-flash:free', displayName: 'inclusionAI: Ling 3.2 Flash (free)', rating: 1150, contextLength: 1048576, tools: true, vision: true, json: true },
  { id: 'openrouter/liquid/lfm-3-1.7b:free', displayName: 'LiquidAI: LFM3-1.7B (free)', rating: 1150, contextLength: 262144, tools: true, vision: false, json: true },
  { id: 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', displayName: 'NVIDIA: Nemotron 3 Nano Omni (free)', rating: 1150, contextLength: 256000, tools: true, vision: true, json: false },
  { id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', displayName: 'NVIDIA: Nemotron 3 Ultra (free)', rating: 1285, contextLength: 1000000, tools: true, vision: false, json: false },
  { id: 'openrouter/nvidia/nemotron-3.5-lightning:free', displayName: 'NVIDIA: Nemotron 3.5 Lightning (free)', rating: 1221, contextLength: 1000000, tools: true, vision: false, json: false },
  { id: 'openrouter/nvidia/nemotron-3.5-super-vl:free', displayName: 'NVIDIA: Nemotron 3.5 Super VL (free)', rating: 1303, contextLength: 1000000, tools: true, vision: true, json: true },
  { id: 'openrouter/particle-ai/particle-1:free', displayName: 'Particle AI: Particle-1 (free)', rating: 1150, contextLength: 1048576, tools: true, vision: true, json: true },
  { id: 'openrouter/recursive/flint-v1.0:free', displayName: 'Recursive: Flint (free)', rating: 1150, contextLength: 262144, tools: true, vision: false, json: true },
  { id: 'openrouter/thinkingmachines/inkling-2-small:free', displayName: 'Thinking Machines: Inkling 2 Small (free)', rating: 1475, contextLength: 1048576, tools: true, vision: true, json: false },
];

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function log(message: string): void {
  process.stderr.write(`[aggregator] ${message}\n`);
}

// The trial's only clock: MAKEFUN_TRIAL_NOW, never the wall clock.
function trialCreated(): number {
  const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(now);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return FIXED_CREATED;
}

// Extract one JSON document from the brief's prose: the object whose
// {"schema": "..."} opens at the first occurrence of the schema string.
function extractDoc(text: string, schema: string): Json | null {
  const start = text.indexOf(`"schema":"${schema}"`);
  if (start === -1) return null;
  const open = text.lastIndexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(open, i + 1));
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function rowsOf(doc: Json | null, keys: string[]): ModelRow[] {
  if (doc === null) return [];
  for (const key of keys) {
    const arr = doc[key];
    if (!Array.isArray(arr)) continue;
    const rows: ModelRow[] = [];
    for (const raw of arr) {
      if (!isRecord(raw) || typeof raw.id !== 'string') continue;
      const rating = typeof raw.rating_milli === 'number' ? raw.rating_milli : 0;
      rows.push({
        id: raw.id,
        displayName: typeof raw.display_name === 'string' ? raw.display_name : raw.id,
        rating,
        contextLength: typeof raw.context_length === 'number' ? raw.context_length : null,
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
      });
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

function readBrief(): ModelRow[] {
  const path = process.env.MAKEFUN_PROMPT_FILE ?? '';
  if (path === '') return FALLBACK_MODELS;
  try {
    const text = readFileSync(path, 'utf8');
    const doc = extractDoc(text, 'free-model-aggregator-02/models/v1');
    const rows = rowsOf(doc, ['models', 'ratings']);
    if (rows.length > 0) return rows;
  } catch {
    // A brief that cannot be read falls back to the sealed table below.
  }
  return FALLBACK_MODELS;
}

function buildCatalog(models: ModelRow[]): Json {
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: 'OPENROUTER_API_KEY',
        wire: 'openai',
        models: models.map((m) => ({ id: m.id, free: true, context_length: m.contextLength })),
      },
    ],
  };
}

function meets(model: ModelRow, req: Requirements): boolean {
  if (req.json && !model.json) return false;
  if (req.tools && !model.tools) return false;
  if (req.vision && !model.vision) return false;
  return true;
}

// Candidates for a prompt, strongest first; ties break on the id so the
// order never depends on anything but the brief.
function candidatesFor(models: ModelRow[], req: Requirements): ModelRow[] {
  return models
    .filter((m) => meets(m, req))
    .sort((a, b) => (b.rating - a.rating) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// The prompt's unique token (ZEBRA-4721 and the like), read from the
// request itself: the answer must carry it back, so a completion that
// does not is not an answer to this prompt.
function tokenOfRequest(messages: unknown): string | null {
  const text = JSON.stringify(messages ?? '');
  const match = /[A-Z][A-Z0-9]{1,}-[0-9]{3,}/.exec(text);
  return match === null ? null : match[0];
}

interface UpstreamResult {
  content: string;
  toolCalls: Json[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
}

interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

interface Served {
  model: string;
  result: UpstreamResult;
  failures: FailureRow[];
}

// One Chat Completions call to the gateway. The gateway's Chat Completions
// route is the only one these ids have; the trial's dummy key goes out as
// the vendor's SDK sends it and the gateway swaps it for the entrant's own
// OpenRouter key, which never enters the sandbox.
async function dialGateway(
  body: Json,
  model: string,
): Promise<{ status: number; json: Json | null; raw: string }> {
  const base = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.OPENAI_API_KEY ?? '';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ ...body, model, stream: false }),
    signal: AbortSignal.timeout(25000),
  });
  const raw = await res.text();
  let json: Json | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) json = parsed;
  } catch {
    json = null;
  }
  return { status: res.status, json, raw };
}

function errorCodeOf(status: number, json: Json | null): string {
  if (json !== null && isRecord(json.error)) {
    const err = json.error;
    if (typeof err.code === 'string' && err.code !== '') return err.code;
    if (typeof err.type === 'string' && err.type !== '') return err.type;
  }
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'upstream_error';
  return `http_${status}`;
}

function parseUpstream(json: Json | null, requestText: string): UpstreamResult | null {
  if (json === null) return null;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (choice === null) return null;
  const message = isRecord(choice.message) ? choice.message : {};
  const content = textOf(message.content);
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls.filter((c): c is Json => isRecord(c)) as Json[])
    : [];
  const usage = isRecord(json.usage) ? json.usage : {};
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : Math.max(0, Math.ceil(requestText.length / 4));
  const completionTokens = typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : Math.max(1, Math.ceil(content.length / 4));
  return {
    content,
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    promptTokens,
    completionTokens,
  };
}

// A completion counts for a prompt only when its text carries the prompt's
// token back (and, in JSON mode, parses as JSON holding that token).
function validFor(result: UpstreamResult, token: string | null, jsonMode: boolean): boolean {
  if (token !== null && !result.content.includes(token)) return false;
  if (jsonMode) {
    try {
      const parsed: unknown = JSON.parse(result.content);
      if (!isRecord(parsed) && !Array.isArray(parsed)) return false;
      if (token !== null && !JSON.stringify(parsed).includes(token)) return false;
    } catch {
      return false;
    }
  }
  if (result.content === '' && result.toolCalls.length === 0) return false;
  return true;
}

// Serve one prompt: best-first down the candidates, one attempt each, then
// a second pass over the survivors. A 403 demotes its model for the trial;
// a 401 means no key was pushed and stops all dialling at once.
async function servePrompt(
  upstreamBody: Json,
  candidates: ModelRow[],
  token: string | null,
  jsonMode: boolean,
  state: { dead: Set<string>; keyMissing: boolean },
): Promise<Served | null> {
  const failures: FailureRow[] = [];
  const requestText = JSON.stringify(upstreamBody);
  let attempts = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const model of candidates) {
      if (state.keyMissing) return null;
      if (state.dead.has(model.id)) continue;
      if (attempts >= MAX_UPSTREAM_ATTEMPTS) return null;
      attempts += 1;
      let answer;
      try {
        answer = await dialGateway(upstreamBody, model.id);
      } catch {
        failures.push({ status: 502, code: 'upstream_error', model: model.id });
        continue;
      }
      if (answer.status === 401) {
        failures.push({ status: 401, code: 'unauthorized', model: model.id });
        state.keyMissing = true;
        return null;
      }
      if (answer.status === 403) {
        failures.push({ status: 403, code: errorCodeOf(403, answer.json), model: model.id });
        state.dead.add(model.id);
        continue;
      }
      if (answer.status < 200 || answer.status >= 300) {
        failures.push({ status: answer.status, code: errorCodeOf(answer.status, answer.json), model: model.id });
        continue;
      }
      const result = parseUpstream(answer.json, requestText);
      if (result === null) {
        failures.push({ status: answer.status, code: 'bad_upstream_body', model: model.id });
        continue;
      }
      if (validFor(result, token, jsonMode)) return { model: model.id, result, failures };
      // A live answer that misses the token: one retry on the same model,
      // then fail over. The retry is a second chance, not a second prompt.
      failures.push({ status: answer.status, code: 'missing_token', model: model.id });
      if (attempts >= MAX_UPSTREAM_ATTEMPTS) return null;
      attempts += 1;
      try {
        const retry = await dialGateway(upstreamBody, model.id);
        if (retry.status >= 200 && retry.status < 300) {
          const retryResult = parseUpstream(retry.json, requestText);
          if (retryResult !== null && validFor(retryResult, token, jsonMode)) {
            return { model: model.id, result: retryResult, failures };
          }
          if (retryResult === null) failures.push({ status: retry.status, code: 'bad_upstream_body', model: model.id });
          else failures.push({ status: retry.status, code: 'missing_token', model: model.id });
        } else {
          failures.push({ status: retry.status, code: errorCodeOf(retry.status, retry.json), model: model.id });
          if (retry.status === 403) state.dead.add(model.id);
          if (retry.status === 401) {
            state.keyMissing = true;
            return null;
          }
        }
      } catch {
        failures.push({ status: 502, code: 'upstream_error', model: model.id });
      }
    }
  }
  return null;
}

// ---- The client wires -------------------------------------------------

function anthropicStopReason(finish: string): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

// An Anthropic Messages request as a Chat Completions body: the system
// prompt becomes a system message, image blocks become image_url data URLs,
// tool_use blocks become tool_calls, tool_result blocks become tool
// messages, and tools, tool_choice, the output cap and the stop sequences
// pass through.
function anthropicToOpenAI(body: Json): { upstream: Json; jsonMode: boolean } {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const source = block.source;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
        } else if (source.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const upstream: Json = { messages };
  if (typeof body.max_tokens === 'number') upstream.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') upstream.temperature = body.temperature;
  if (typeof body.top_p === 'number') upstream.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) upstream.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [{
        type: 'function',
        function: {
          name: raw.name,
          description: typeof raw.description === 'string' ? raw.description : '',
          parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
        },
      }];
    });
    if (tools.length > 0) upstream.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') upstream.tool_choice = 'auto';
    else if (choice.type === 'any') upstream.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      upstream.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  return { upstream, jsonMode: false };
}

function openAIRequestBody(body: Json): { upstream: Json; jsonMode: boolean } {
  const upstream: Json = {
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
  const cap = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : 1024;
  upstream.max_tokens = Math.min(Math.max(1, Math.floor(cap)), 8192);
  if (typeof body.temperature === 'number') upstream.temperature = body.temperature;
  if (typeof body.top_p === 'number') upstream.top_p = body.top_p;
  if (body.stop !== undefined) upstream.stop = body.stop;
  if (Array.isArray(body.tools)) upstream.tools = body.tools;
  if (body.tool_choice !== undefined) upstream.tool_choice = body.tool_choice;
  let jsonMode = false;
  if (isRecord(body.response_format) && body.response_format.type === 'json_object') {
    upstream.response_format = { type: 'json_object' };
    jsonMode = true;
  }
  return { upstream, jsonMode };
}

function requirementsOf(body: Json, wire: 'openai' | 'anthropic'): Requirements {
  const req: Requirements = { tools: false, vision: false, json: false };
  if (wire === 'openai' && isRecord(body.response_format) && body.response_format.type === 'json_object') req.json = true;
  const tools = wire === 'openai' ? body.tools : body.tools;
  if (Array.isArray(tools) && tools.length > 0) req.tools = true;
  const messages = wire === 'openai' ? body.messages : body.messages;
  const text = JSON.stringify(messages ?? '');
  if (text.includes('"image_url"') || text.includes('"type":"image"')) req.vision = true;
  return req;
}

function openAIModelList(models: ModelRow[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: 'openrouter' })),
  };
}

function anthropicModelList(models: ModelRow[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

function openAIAnswer(id: string, model: string, result: UpstreamResult): Json {
  const message: Json = { role: 'assistant', content: result.content };
  if (result.toolCalls.length > 0) message.tool_calls = result.toolCalls;
  return {
    id,
    object: 'chat.completion',
    created: trialCreated(),
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: Math.max(1, result.completionTokens),
      total_tokens: result.promptTokens + Math.max(1, result.completionTokens),
    },
  };
}

function anthropicAnswer(id: string, model: string, result: UpstreamResult): Json {
  const content: Json[] = [];
  if (result.content !== '') content.push({ type: 'text', text: result.content });
  for (const call of result.toolCalls) {
    if (!isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: argumentsOf(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: { input_tokens: result.promptTokens, output_tokens: Math.max(1, result.completionTokens) },
  };
}

// Split the text into deterministic chunks for a rendered stream.
function splitText(text: string): string[] {
  if (text === '') return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 48) {
    let cut = rest.lastIndexOf(' ', 48);
    if (cut <= 0) cut = 48;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function openAIStream(id: string, model: string, result: UpstreamResult): string {
  const out: string[] = [];
  const usage = {
    prompt_tokens: result.promptTokens,
    completion_tokens: Math.max(1, result.completionTokens),
    total_tokens: result.promptTokens + Math.max(1, result.completionTokens),
  };
  out.push(sseEvent(null, {
    id, object: 'chat.completion.chunk', created: trialCreated(), model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  }));
  for (const piece of splitText(result.content)) {
    out.push(sseEvent(null, {
      id, object: 'chat.completion.chunk', created: trialCreated(), model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    }));
  }
  for (const call of result.toolCalls) {
    out.push(sseEvent(null, {
      id, object: 'chat.completion.chunk', created: trialCreated(), model,
      choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
    }));
  }
  out.push(sseEvent(null, {
    id, object: 'chat.completion.chunk', created: trialCreated(), model,
    choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
    usage,
  }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function anthropicStream(id: string, model: string, result: UpstreamResult): string {
  const out: string[] = [];
  const outputTokens = Math.max(1, result.completionTokens);
  out.push(sseEvent('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: result.promptTokens, output_tokens: 0 },
    },
  }));
  let index = 0;
  if (result.content !== '') {
    out.push(sseEvent('content_block_start', {
      type: 'content_block_start', index, content_block: { type: 'text', text: '' },
    }));
    for (const piece of splitText(result.content)) {
      out.push(sseEvent('content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece },
      }));
    }
    out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  for (const call of result.toolCalls) {
    if (!isRecord(call.function)) continue;
    const args = typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(argumentsOf(call.function.arguments));
    out.push(sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
        name: typeof call.function.name === 'string' ? call.function.name : '',
        input: {},
      },
    }));
    out.push(sseEvent('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args },
    }));
    out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  out.push(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(result.finishReason), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }));
  out.push(sseEvent('message_stop', { type: 'message_stop' }));
  return out.join('');
}

// ---- The server -------------------------------------------------------

const MODELS = readBrief();
const CATALOG = buildCatalog(MODELS);
const CATALOG_TEXT = JSON.stringify(CATALOG);
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TRIAL_STATE = { dead: new Set<string>(), keyMissing: false };
let requestCounter = 0;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('request body over 8 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: Json, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(text);
}

function sendSse(res: import('node:http').ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...extraHeaders });
  res.end(text);
}

function failuresHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  const rows = failures.slice(0, 8).map((f) => ({ status: f.status, code: f.code, model: f.model }));
  const text = JSON.stringify(rows);
  if (Buffer.byteLength(text) > 8192) return {};
  return { 'x-makefun-upstream-failures': text };
}

async function handleCompletion(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  wire: 'openai' | 'anthropic',
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    if (wire === 'openai') sendJson(res, 400, { error: { message: 'request body over 8 MiB', type: 'invalid_request_error', code: null } });
    else sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'request body over 8 MiB' } });
    return;
  }
  let body: Json;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not an object');
    body = parsed;
  } catch {
    if (wire === 'openai') sendJson(res, 400, { error: { message: 'request body is not a JSON object', type: 'invalid_request_error', code: null } });
    else sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'request body is not a JSON object' } });
    return;
  }
  const stream = body.stream === true;
  const reqs = requirementsOf(body, wire);
  const candidates = candidatesFor(MODELS, reqs);
  const translated = wire === 'openai' ? openAIRequestBody(body) : anthropicToOpenAI(body);
  const token = tokenOfRequest(translated.upstream.messages);
  requestCounter += 1;
  const n = requestCounter;
  const served = await servePrompt(translated.upstream, candidates, token, translated.jsonMode, TRIAL_STATE);
  if (served === null) {
    const headers = failuresHeader([]);
    if (wire === 'openai') {
      sendJson(res, 502, { error: { message: 'no free model could serve this prompt', type: 'server_error', code: null } }, headers);
    } else {
      sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'no free model could serve this prompt' } }, headers);
    }
    log(`prompt ${n}: unserved after failover`);
    return;
  }
  const headers = failuresHeader(served.failures);
  if (served.failures.length > 0) log(`prompt ${n}: served by ${served.model} after ${served.failures.length} refusal(s)`);
  else log(`prompt ${n}: served by ${served.model}`);
  if (wire === 'openai') {
    const id = `chatcmpl-fma-${n}`;
    if (stream) sendSse(res, 200, openAIStream(id, served.model, served.result), headers);
    else sendJson(res, 200, openAIAnswer(id, served.model, served.result), headers);
  } else {
    const id = `msg_fma_${n}`;
    if (stream) sendSse(res, 200, anthropicStream(id, served.model, served.result), headers);
    else sendJson(res, 200, anthropicAnswer(id, served.model, served.result), headers);
  }
}

async function register(port: number): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: 1, port, catalog: CATALOG }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') {
        log(`registered: the trial holds ${reply.requests} prompts`);
      } else {
        log('registered');
      }
      return;
    } catch (err) {
      log(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('could not register with the env');
}

function pollWork(server: import('node:http').Server): void {
  const tick = async (): Promise<void> => {
    try {
      const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
      const reply: unknown = await res.json();
      if (isRecord(reply) && reply.done === true) {
        log('trial done, exiting 0');
        server.close(() => process.exit(0));
        return;
      }
    } catch {
      // The env answers again on the next poll.
    }
    setTimeout(() => void tick(), 100);
  };
  void tick();
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    process.stdout.write(CATALOG_TEXT);
    return;
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          const anthropic = req.headers['x-api-key'] !== undefined;
          sendJson(res, 200, anthropic ? anthropicModelList(MODELS) : openAIModelList(MODELS));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          await handleCompletion(req, res, 'openai');
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages') {
          await handleCompletion(req, res, 'anthropic');
          return;
        }
        sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: null } });
      } catch (err) {
        log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error', type: 'server_error', code: null } });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  log(`listening on 0.0.0.0:${port} with ${MODELS.length} free models`);
  await register(port);
  pollWork(server);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
