const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const REQUEST_TIMEOUT_MS = 45000;
const MAX_COMPLETION_TOKENS = 1500;

function getApiKey() {
  return process.env.GROQ_API_KEY?.trim() || '';
}

function getModel() {
  return process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

function describeApiError(body) {
  const error = body?.error || {};
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const code = error.code || body?.code;
  return [message || 'Groq request failed.', code ? `(code ${code})` : ''].filter(Boolean).join(' ');
}

async function readStreamingAnswer(response, onToken) {
  if (!response.body?.getReader || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json().catch(() => ({}));
    if (body?.error) throw new Error(describeApiError(body));
    const answer = normalizeContent(body?.choices?.[0]?.message?.content);
    if (!answer) throw new Error('Groq returned an empty answer. Please try again.');
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

  if (!answer.trim()) throw new Error('Groq returned an empty answer. Please try again.');
  return answer.trim();
}

async function answerFromTranscript({ transcript = '', question = '', notes = '' } = {}, onToken) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Add GROQ_API_KEY to your .env file, then restart MEETR to enable voice answers.');
  }

  const transcriptText = String(transcript).slice(-6000).trim();
  if (!transcriptText) {
    throw new Error('No voice transcript was captured. Speak a question, then press Stop to send it.');
  }

  const notesText = String(notes).slice(0, 4000).trim() || '(No resume notes provided)';
  const voiceQuestion = String(question).trim() || transcriptText.split('\n').filter(Boolean).at(-1) || '';
  const prompt = [
    'You are a fast voice assistant. Answer the latest spoken question accurately, put the answer first, and keep it concise. Never give a one-word safety classification unless asked to classify safety.',
    '',
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const model = getModel();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        temperature: 0.2,
        ...(model.startsWith('openai/gpt-oss-')
          ? { reasoning_effort: 'low', include_reasoning: false }
          : {}),
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`Groq request failed (${response.status}): ${describeApiError(body)}`);
    }

    return await readStreamingAnswer(response, onToken);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Groq took too long to respond. Please try again.');
    }
    if (error instanceof TypeError) {
      throw new Error('Could not reach Groq. Check your internet connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  getApiKey,
  getModel,
  answerFromTranscript,
};
