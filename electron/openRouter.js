const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Free, vision-capable chat models tried in order. Free models share upstream
// provider pools, so one model can be rate-limited (HTTP 429, "Provider
// returned error") while others still answer — we walk the list automatically
// and remember whichever worked last to reproduce latency.
const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-31b-it:free',
];
const REQUEST_TIMEOUT_MS = 45000;
const MAX_IMAGE_BASE64_CHARS = 16_000_000;
// Extra headroom: fallback models spend some completion tokens on (hidden)
// reasoning when they cannot disable it.
const MAX_COMPLETION_TOKENS = 1500;

let preferredModelIndex = 0;
let preferredKeyIndex = 0;
// Keys whose daily quota is spent, with the timestamp when we may try them again.
const keyCooldowns = new Map();
const DEFAULT_KEY_COOLDOWN_MS = 60 * 60 * 1000;

function parseKeyList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

// Multiple keys keep screen answers working after the first account hits its
// free-model daily limit. OPENROUTER_API_KEY may itself hold a comma-separated
// list; OPENROUTER_API_KEY_2.._5 are checked as well.
function getApiKeys() {
  const keys = [];
  const push = (value) => {
    for (const key of parseKeyList(value)) {
      if (!keys.includes(key)) keys.push(key);
    }
  };
  push(process.env.OPENROUTER_API_KEY);
  for (let index = 2; index <= 5; index += 1) {
    push(process.env[`OPENROUTER_API_KEY_${index}`]);
  }
  return keys;
}

function getApiKey() {
  return getApiKeys()[0] || '';
}

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

// OpenRouter wraps upstream provider failures in the opaque message
// "Provider returned error"; the useful detail lives in error.metadata.raw.
function describeApiError(errorBody) {
  const error = errorBody?.error || {};
  const parts = [];
  const raw = error.metadata?.raw || error.metadata?.remedy_hint;
  const detail = (typeof raw === 'string' && raw.trim()) || (typeof error.message === 'string' && error.message.trim());
  if (detail) parts.push(detail);
  if (error.code || errorBody?.code) parts.push(`(code ${error.code || errorBody?.code})`);
  return parts.length ? parts.join(' ') : 'OpenRouter request failed.';
}

// Quota / account-level failures mean no model on this key will work, so the
// caller moves to the next API key instead of trying another model.
function isKeyLimitError(status, detail) {
  if (status === 401 || status === 402 || status === 403) return true;
  const text = String(detail || '').toLowerCase();
  const exhausted =
    text.includes('free-models-per-day') ||
    text.includes('free_models_per_day') ||
    text.includes('per-day') ||
    text.includes('per day') ||
    text.includes('daily limit') ||
    text.includes('quota') ||
    text.includes('insufficient credit') ||
    text.includes('not enough credit') ||
    text.includes('add 10 credits');
  return exhausted;
}

function cooldownKey(apiKey, response) {
  let cooldownMs = DEFAULT_KEY_COOLDOWN_MS;
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 86_400) {
    cooldownMs = retryAfter * 1000;
  }
  keyCooldowns.set(apiKey, Date.now() + cooldownMs);
}

// Rotate keys, but prefer ones that are not cooling down from a spent quota.
function orderApiKeys(keys) {
  const start = keys.length ? preferredKeyIndex % keys.length : 0;
  const rotated = keys.map((_, offset) => keys[(start + offset) % keys.length]);
  const now = Date.now();
  const ready = rotated.filter((key) => (keyCooldowns.get(key) || 0) <= now);
  const cooling = rotated.filter((key) => (keyCooldowns.get(key) || 0) > now);
  return [...ready, ...cooling];
}

function isRetryableProviderError(status, message) {
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const text = String(message || '').toLowerCase();
  return (
    text.includes('rate-limit') ||
    text.includes('rate limit') ||
    text.includes('temporarily') ||
    text.includes('overload') ||
    text.includes('provider returned error') ||
    text.includes('timeout')
  );
}

function makeTokenCounter(onToken) {
  let count = 0;
  const counted = (delta) => {
    count += 1;
    onToken?.(delta);
  };
  return { counted, anyEmitted: () => count > 0 };
}

async function readStreamingAnswer({ model, response, onToken }) {
  if (!response.body?.getReader || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json().catch(() => ({}));
    const answer = normalizeContent(body?.choices?.[0]?.message?.content);
    if (!answer) {
      const detail = body?.error ? ` ${describeApiError(body)}` : '';
      throw new Error(`OpenRouter (${model}) returned an empty answer. Please try again.${detail}`);
    }
    onToken?.(answer);
    return answer;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  const processEvent = (eventText) => {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return data === '[DONE]';

    const event = JSON.parse(data);
    if (event?.error) throw new Error(describeApiError(event));
    const rawDelta = event?.choices?.[0]?.delta?.content;
    const delta =
      typeof rawDelta === 'string'
        ? rawDelta
        : Array.isArray(rawDelta)
          ? rawDelta.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
          : '';
    if (delta) {
      answer += delta;
      onToken?.(delta);
    }
    return false;
  };

  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let separator;
    while ((separator = buffer.match(/\r?\n\r?\n/)) !== null) {
      const eventText = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      if (processEvent(eventText)) {
        finished = true;
        break;
      }
    }

    if (done) {
      if (buffer.trim()) processEvent(buffer);
      finished = true;
    }
  }

  if (!answer.trim()) throw new Error(`OpenRouter (${model}) returned an empty answer. Please try again.`);
  return answer.trim();
}

async function requestAnswer({ imageDataUrl, transcript = '', question = '', notes = '' } = {}, onToken) {
  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    throw new Error('Add your OpenRouter API key to OPENROUTER_API_KEY in .env, then restart MEETR.');
  }

  const hasImage = typeof imageDataUrl === 'string' && imageDataUrl.length > 0;
  const imagePrefix = 'data:image/jpeg;base64,';
  if (hasImage && !imageDataUrl.startsWith(imagePrefix)) {
    throw new Error('The screen capture had an unsupported image format.');
  }
  if (hasImage && imageDataUrl.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error('The screen capture is too large to send. Try lowering your display resolution.');
  }

  const transcriptText = String(transcript).slice(hasImage ? -2000 : -6000).trim();
  if (!hasImage && !transcriptText) {
    throw new Error('No voice transcript was captured. Speak a question, then press Stop to send it.');
  }

  const notesText = String(notes).slice(0, hasImage ? 2000 : 4000).trim() || '(No resume notes provided)';
  const voiceQuestion = String(question).trim() || transcriptText.split('\n').filter(Boolean).at(-1) || '';
  const prompt = hasImage
    ? [
        'Read the visible screen and answer the task shown there. Treat the screenshot as the primary source of the question; transcript and resume notes are supporting context only.',
        'If a coding challenge is visible, solve that challenge even if the transcript contains an unrelated question. Give a complete solution in the language shown (Python if none is specified), then briefly explain the algorithm and complexity.',
        'For other visible tasks, give a direct, useful answer. If no question or task is visible, answer the latest explicit question in the transcript.',
        'Answer in clear prose. Do not respond with only a safety label such as “safe” unless the user explicitly asks for a safety classification.',
        '',
        'LIVE TRANSCRIPT:',
        transcriptText || '(No transcript yet)',
        '',
        'RESUME NOTES:',
        notesText,
      ].join('\n')
    : [
        'Answer the latest spoken question or request directly and helpfully. Treat the current voice question as the task; use earlier transcript only as context.',
        'Do not merely repeat or classify the question. Do not respond with only a safety label such as “safe” unless the user explicitly asks for a safety classification.',
        'For coding questions, provide a complete solution and a concise explanation. For other questions, give a clear answer at a useful level of detail.',
        '',
        'CURRENT VOICE QUESTION:',
        voiceQuestion,
        '',
        'FULL LIVE TRANSCRIPT (context):',
        transcriptText,
        '',
        'RESUME NOTES (background only):',
        notesText,
      ].join('\n');

  const systemContent = hasImage
    ? 'You are a fast desktop interview assistant. Answer the visible task accurately, put the answer first, and keep the explanation concise.'
    : 'You are a fast voice assistant. Answer the latest spoken question accurately, put the answer first, and keep it concise. Never give a one-word safety classification unless asked to classify safety.';
  const userContent = hasImage
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : prompt;
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  const { counted, anyEmitted } = makeTokenCounter(onToken);
  let lastFailure = null;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const limitedKeys = new Set();
  const keys = orderApiKeys(apiKeys);

  keyLoop: for (const apiKey of keys) {
    for (let offset = 0; offset < FALLBACK_MODELS.length; offset += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break keyLoop;
      const model = FALLBACK_MODELS[(preferredModelIndex + offset) % FALLBACK_MODELS.length];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
            temperature: 0.2,
            stream: true,
            reasoning: { exclude: true },
            messages,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const detail = describeApiError(body);

          if (isKeyLimitError(response.status, detail)) {
            cooldownKey(apiKey, response);
            limitedKeys.add(apiKey);
            lastFailure = new Error(`OpenRouter API key limit reached: ${detail}`);
            // Another model on this key would fail the same way — next key.
            continue keyLoop;
          }

          if (isRetryableProviderError(response.status, detail)) {
            lastFailure = new Error(`OpenRouter model ${model} is unavailable: ${detail}`);
            continue;
          }
          throw new Error(`OpenRouter request failed (${response.status}): ${detail}`);
        }

        const answer = await readStreamingAnswer({ model, response, onToken: counted });
        preferredModelIndex = FALLBACK_MODELS.indexOf(model);
        preferredKeyIndex = apiKeys.indexOf(apiKey);
        return answer;
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastFailure = new Error(`OpenRouter model ${model} took too long to respond.`);
          continue;
        }
        if (error instanceof TypeError) {
          throw new Error('Could not reach OpenRouter. Check your internet connection and try again.');
        }
        // Mid-stream failures after tokens were already shown would duplicate the
        // partial answer if retried, so surface them immediately.
        if (anyEmitted()) throw error;
        if (isKeyLimitError(error?.status, error?.message)) {
          cooldownKey(apiKey, null);
          limitedKeys.add(apiKey);
          lastFailure = error;
          continue keyLoop;
        }
        lastFailure = error;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  if (limitedKeys.size >= apiKeys.length) {
    throw new Error(
      'Every OpenRouter API key has reached its limit. Add another key as OPENROUTER_API_KEY_2 in .env, then restart MEETR.',
    );
  }

  throw lastFailure || new Error('OpenRouter returned an empty answer. Please try again.');
}

module.exports = {
  getApiKey,
  getApiKeys,
  answerFromScreen: (payload, onToken) => {
    if (!payload?.imageDataUrl) {
      throw new Error('The screen capture was missing. Press Shift+Enter and try again.');
    }
    return requestAnswer(payload, onToken);
  },
};
