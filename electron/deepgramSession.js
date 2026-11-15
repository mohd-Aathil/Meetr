const { DeepgramClient } = require('@deepgram/sdk');

const TARGET_SAMPLE_RATE = 16000;

/** @type {import('@deepgram/sdk').ListenV1Socket | null} */
let connection = null;
/** @type {AbortController | null} */
let abortController = null;

function getApiKey() {
  return process.env.DEEPGRAM_API_KEY?.trim() || '';
}

/**
 * @param {(payload: { type: string, text?: string, message?: string }) => void} emit
 */
async function startSession(emit) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY is missing. Add it to your .env file.');
  }

  await stopSession();

  abortController = new AbortController();
  const client = new DeepgramClient({ apiKey });

  connection = await client.listen.v1.connect({
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    sample_rate: String(TARGET_SAMPLE_RATE),
    channels: '1',
    punctuate: 'true',
    interim_results: 'true',
    smart_format: 'true',
    abortSignal: abortController.signal,
    reconnectAttempts: 0,
  });

  connection.on('open', () => {
    emit({ type: 'status', message: 'listening' });
  });

  connection.on('message', (data) => {
    if (!data || data.type !== 'Results') return;

    const transcript = data.channel?.alternatives?.[0]?.transcript?.trim() || '';
    if (!transcript) return;

    emit({
      type: data.is_final ? 'final' : 'interim',
      text: transcript,
    });
  });

  connection.on('error', (error) => {
    const message = error?.message || String(error);
    emit({ type: 'error', message });
  });

  connection.on('close', () => {
    emit({ type: 'status', message: 'idle' });
  });

  connection.connect();
  await connection.waitForOpen();
  return { sampleRate: TARGET_SAMPLE_RATE };
}

/**
 * @param {ArrayBuffer | Buffer | Uint8Array} chunk
 */
function sendAudio(chunk) {
  if (!connection) return;
  try {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
    if (buffer.byteLength === 0) return;
    connection.sendMedia(buffer);
  } catch {
    // Ignore sends while the socket is closing.
  }
}

async function stopSession() {
  const active = connection;
  const controller = abortController;
  connection = null;
  abortController = null;

  if (!active) {
    controller?.abort();
    return;
  }

  let closeTimer;
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = () => {
      clearTimeout(closeTimer);
      active.off?.('close', onClose);
      resolve();
    };
    closeTimer = setTimeout(() => {
      active.off?.('close', onClose);
      resolve();
    }, 700);
    active.on('close', onClose);
  });

  try {
    // Let Deepgram flush the last utterance before closing the socket.
    active.sendCloseStream?.({ type: 'CloseStream' });
    await closed;
  } catch {
    // no-op
  } finally {
    clearTimeout(closeTimer);
    active.off?.('close', onClose);
    try {
      active.close?.();
    } catch {
      // no-op
    }
    controller?.abort();
  }
}

module.exports = {
  TARGET_SAMPLE_RATE,
  getApiKey,
  startSession,
  sendAudio,
  stopSession,
};
