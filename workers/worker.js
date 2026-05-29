// ══════════════════════════════════════════════════════════════════
//  Diana Birthday — Character Chat Worker  (Kimi / OpenAI 兼容 · 流式)
//  Cloudflare Worker：代理大模型 Chat Completions 接口，注入角色人格，
//  并以 SSE 把回复"逐字"流式转发给网页。
//
//  默认接 Kimi（Moonshot）。因为走的是 OpenAI 兼容协议，换成 DeepSeek /
//  通义 / OpenAI 等只需改 BASE_URL + MODEL + key 三样，前端完全不用动。
//
//  · 单人聊天：模型直接输出对话，逐 token 流式显示。
//  · 群聊：模型按 `角色id<分隔符>台词\n` 逐行输出；worker 解析后，
//    每个角色一条气泡依次浮现，台词也逐字打出。
//
//  部署需要的密钥/变量（见 README）：
//    LLM_API_KEY   (secret)  —— 必填，你的 Kimi key（sk-...）
//    MODEL         (var)     —— 可选，默认 moonshot-v1-32k
//    BASE_URL      (var)     —— 可选，默认 https://api.moonshot.cn/v1
//    ALLOW_ORIGIN  (var)     —— 可选，CORS 白名单，默认 *
// ══════════════════════════════════════════════════════════════════

import { SHARED_CONTEXT, PERSONAS, CHAR_NAMES, WORLD_NAMES } from './personas.js';

const DEFAULT_BASE  = 'https://api.moonshot.cn/v1';
const DEFAULT_MODEL = 'moonshot-v1-32k';
const TEMPERATURE   = 0.7;     // 角色扮演活一点
const MAX_TOKENS    = 1400;
const MAX_HISTORY   = 24;      // 最多保留多少轮历史
const MAX_MSG_LEN   = 2000;    // 单条用户消息字数上限

export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOW_ORIGIN || '*';
    const corsOrigin = allowedOrigin === '*' ? (reqOrigin || '*') : allowedOrigin;
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return json({ error: 'Method not allowed' }, 405, cors);
    if (!env.LLM_API_KEY)             return json({ error: 'Server not configured (missing API key).' }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON.' }, 400, cors); }

    const { worldId, charIds, history, message, mode } = body || {};

    // ── 校验 ──
    if (!worldId || !PERSONAS[worldId])                  return json({ error: 'Unknown world.' }, 400, cors);
    if (!Array.isArray(charIds) || charIds.length === 0) return json({ error: 'No characters selected.' }, 400, cors);
    const worldPersonas = PERSONAS[worldId];
    const validChars = charIds.filter(id => worldPersonas[id]);
    if (validChars.length === 0)                         return json({ error: 'No valid characters.' }, 400, cors);
    if (typeof message !== 'string' || !message.trim())  return json({ error: 'Empty message.' }, 400, cors);

    const userMsg  = message.slice(0, MAX_MSG_LEN);
    const isGroup  = mode === 'group' || validChars.length > 1;
    const system   = isGroup ? buildGroupSystem(worldId, validChars)
                             : buildSingleSystem(worldId, validChars[0]);
    // OpenAI 兼容：system 作为第一条 message
    const messages = [{ role: 'system', content: system }, ...buildMessages(history, userMsg, isGroup)];

    // ── 调上游（OpenAI 兼容 chat/completions，流式）──
    const base = (env.BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
    let upstream;
    try {
      upstream = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          messages,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          stream: true,
        }),
      });
    } catch {
      return json({ error: 'Upstream request failed.' }, 502, cors);
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await safeText(upstream);
      return json({ error: 'Upstream error.', status: upstream.status, detail }, 502, cors);
    }

    // ── 把上游 SSE 转换成我们自己的 SSE 协议 ──
    //   event: start  data:{charId}   —— 某角色开始说话（新气泡）
    //   event: delta  data:{text}     —— 往当前气泡追加文字
    //   event: end    data:{}         —— 当前气泡说完
    //   event: done   data:{}         —— 整轮结束
    //   event: error  data:{message}  —— 出错
    const stream = new ReadableStream({
      async start(controller) {
        const enc  = new TextEncoder();
        const send = (event, data) =>
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`));

        const validSet = new Set(validChars);
        // 中文名 → id 反查表（容忍模型用中文名作前缀）
        const nameToId = {};
        for (const [id, name] of Object.entries(CHAR_NAMES[worldId] || {})) {
          if (validSet.has(id)) nameToId[name] = id;
        }
        const resolveId = s => {
          const t = s.trim().replace(/^[\s\-*【「『\[（(]+/, '').trim();   // 去掉前导括号/符号/序号噪声
          return validSet.has(t) ? t
               : validSet.has(t.toLowerCase()) ? t.toLowerCase()
               : nameToId[t] || null;
        };

        // 解析状态
        let started = false;        // 单聊：是否已发过 start
        let gState  = 'id';         // 群聊：'id' | 'text'
        let idBuf   = '';           // 群聊：正在累计的角色 id
        let inLine  = false;        // 群聊：当前行是否已 start
        let textBegun = false;      // 群聊：当前行台词是否已开始（用于跳过前导空格）
        function onText(chunk) {
          if (!isGroup) {
            if (!started) { send('start', { charId: validChars[0] }); started = true; }
            send('delta', { text: chunk });
            return;
          }
          // 群聊：按 id<分隔符>text\n 逐字解析（分隔符容忍 Tab / 空格 / 冒号）
          let seg = '';
          for (const ch of chunk) {
            if (gState === 'id') {
              const isSep = ch === '\t' || ch === ' ' || ch === ':' || ch === '：' || ch === '|'
                         || ch === '→' || ch === '>' || ch === '】' || ch === ']';
              if (ch === '\n') {
                idBuf = '';                                   // 空行 / 噪声，跳过
              } else if (isSep) {
                const resolved = resolveId(idBuf);
                if (resolved) {
                  send('start', { charId: resolved }); idBuf = ''; gState = 'text'; inLine = true; textBegun = false;
                } else {
                  idBuf += ch;
                }
              } else {
                idBuf += ch;
              }
            } else { // text
              if (ch === '\n') {
                if (seg) { send('delta', { text: seg }); seg = ''; }
                send('end', {}); gState = 'id'; idBuf = ''; inLine = false;
              } else if (!textBegun && (ch === ' ' || ch === '\t')) {
                // 跳过冒号后的前导空格
              } else {
                textBegun = true;
                seg += ch;
              }
            }
          }
          if (seg) send('delta', { text: seg });
        }

        function flushEnd() {
          if (isGroup) { if (inLine) send('end', {}); }
          else         { if (started) send('end', {}); }
        }

        try {
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let sseBuf = '';
          let finished = false;

          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuf += dec.decode(value, { stream: true });

            let idx;
            while ((idx = sseBuf.indexOf('\n')) >= 0) {
              const line = sseBuf.slice(0, idx).trim();
              sseBuf = sseBuf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;       // 跳过空行 / 注释 / event 行

              const payload = line.slice(5).trim();
              if (payload === '[DONE]') { finished = true; break; }
              if (!payload) continue;

              let evt;
              try { evt = JSON.parse(payload); } catch { continue; }

              const delta = evt.choices?.[0]?.delta?.content;
              if (delta) onText(delta);
            }
          }

          flushEnd();
          send('done', {});
        } catch {
          send('error', { message: 'stream interrupted' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  },
};

// ──────────────────────────────────────────────
//  SYSTEM PROMPTS
// ──────────────────────────────────────────────
function buildSingleSystem(worldId, charId) {
  const name = CHAR_NAMES[worldId]?.[charId] || charId;
  const persona = PERSONAS[worldId][charId];
  return [
    SHARED_CONTEXT,
    `\n【你的身份】\n你现在是「${WORLD_NAMES[worldId]}」里的${name}。`,
    persona,
    `\n现在，${name}，和她聊天吧。只用${name}的身份、语气直接说话——不要写角色名前缀，不要旁白，不要解释你的思考过程，直接输出这句话本身。`,
  ].join('\n');
}

function buildGroupSystem(worldId, charIds) {
  const names = charIds.map(id => CHAR_NAMES[worldId]?.[id] || id);
  const roster = charIds.map(id => {
    const name = CHAR_NAMES[worldId]?.[id] || id;
    return `### ${name}（id: ${id}）\n${PERSONAS[worldId][id]}`;
  }).join('\n\n');

  return [
    SHARED_CONTEXT,
    `\n【群聊场景】\n这是一个「${WORLD_NAMES[worldId]}」的群聊房间。在场的角色有：${names.join('、')}。`,
    `你要同时扮演这些角色，让他们像真的在一个房间里那样自然对话——他们之间也可以互相回应、拌嘴、接话。`,
    `\n【在场角色设定】\n${roster}`,
    `\n【输出格式 —— 必须严格遵守】`,
    `每一句发言单独占一行，格式为：角色id + 一个英文冒号 + 这句话的内容。`,
    `例如：`,
    `${charIds[0]}:台词内容……`,
    `${charIds[Math.min(1, charIds.length - 1)]}:另一句台词`,
    `规则：`,
    `- 行首必须是上面列出的角色 id 之一（全小写、原样照抄），紧跟一个英文冒号 ":"，再写台词。`,
    `- 不要输出角色的中文名作为前缀，不要输出 JSON、引号包裹、序号或任何额外说明文字。`,
    `- 不一定每个角色都要说话；让对话自然，通常 2～4 句刚好。性格活跃的角色多说，沉默的角色（如绫波丽、义勇）可只回一句或不出声。`,
    `- 每句简短自然、符合该角色语气，可以互相调侃接梗。`,
  ].join('\n');
}

// ──────────────────────────────────────────────
//  MESSAGES
// ──────────────────────────────────────────────
function buildMessages(history, userMsg, isGroup) {
  const msgs = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-MAX_HISTORY)) {
      if (!h || typeof h.text !== 'string') continue;
      if (h.role === 'user') {
        msgs.push({ role: 'user', content: h.text.slice(0, MAX_MSG_LEN) });
      } else if (h.role === 'assistant') {
        const prefix = isGroup && h.name ? `${h.name}：` : '';
        msgs.push({ role: 'assistant', content: prefix + h.text });
      }
    }
  }
  msgs.push({ role: 'user', content: userMsg });
  return collapse(ensureLeadingUser(msgs));
}

function ensureLeadingUser(msgs) {
  let i = 0;
  while (i < msgs.length && msgs[i].role !== 'user') i++;
  return msgs.slice(i);
}

function collapse(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

// ──────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function safeText(resp) {
  try { return (await resp.text()).slice(0, 500); } catch { return ''; }
}
