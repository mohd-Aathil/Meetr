import { useCallback, useEffect, useRef, useState } from 'react';
import { startAudioCapture } from './lib/audioCapture';

function getMeetr() {
  const api = typeof window !== 'undefined' ? window.meetr : undefined;
  if (!api) {
    throw new Error('Electron bridge missing. Use npm start (not the Vite URL in a browser).');
  }
  return api;
}

function isVoiceQuestion(text) {
  const question = String(text || '').trim().toLowerCase();
  if (!question) return false;
  if (/[?？]\s*$/.test(question)) return true;
  return /^(what|why|how|when|where|who|whom|whose|which|is|are|am|was|were|do|does|did|can|could|would|will|should|have|has|had|may|might|explain|solve|tell me|help me)\b/.test(
    question,
  );
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [autoAnswerEnabled, setAutoAnswerEnabled] = useState(() => {
    try {
      return window.localStorage.getItem('meetr:auto-answer') !== 'false';
    } catch {
      return true;
    }
  });
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [finalLines, setFinalLines] = useState([]);
  const [interim, setInterim] = useState('');
  const [hasApiKey, setHasApiKey] = useState(true);
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [aiState, setAiState] = useState('idle');
  const [aiMode, setAiMode] = useState('voice');
  const [aiAnswer, setAiAnswer] = useState('');
  const [displayedAnswer, setDisplayedAnswer] = useState('');
  const [aiError, setAiError] = useState('');

  const transcriptRef = useRef(null);
  const stopCaptureRef = useRef(null);
  const startingRef = useRef(false);
  const aiRequestRef = useRef(0);
  const streamingAnswerRef = useRef(false);
  const lastSubmittedTranscriptRef = useRef('');
  const contextRef = useRef({ notes, finalLines, interim });
  const listeningRef = useRef(listening);
  const autoAnswerEnabledRef = useRef(autoAnswerEnabled);
  contextRef.current = { notes, finalLines, interim };
  listeningRef.current = listening;
  autoAnswerEnabledRef.current = autoAnswerEnabled;

  const submitVoiceTranscript = useCallback((question = '') => {
    const context = contextRef.current;
    const transcript = [...context.finalLines, context.interim].filter(Boolean).join('\n').trim();
    if (!transcript) return false;

    const transcriptKey = transcript.toLowerCase().replace(/\s+/g, ' ');
    if (transcriptKey === lastSubmittedTranscriptRef.current) return false;
    lastSubmittedTranscriptRef.current = transcriptKey;

    const requestId = ++aiRequestRef.current;
    streamingAnswerRef.current = true;
    setAiMode('voice');
    setAiAnswer('');
    setDisplayedAnswer('');
    setAiError('');
    setAiState('thinking');
    setSettingsOpen(false);

    getMeetr()
      .askGroq({
        requestId,
        transcript,
        question: question || context.interim || context.finalLines.at(-1) || transcript,
        notes: context.notes,
      })
      .then((answer) => {
        if (requestId !== aiRequestRef.current) return;
        setAiAnswer(answer);
        setAiState('done');
      })
      .catch((requestError) => {
        if (requestId !== aiRequestRef.current) return;
        lastSubmittedTranscriptRef.current = '';
        setAiError(requestError?.message || String(requestError));
        setAiState('error');
      });

    return true;
  }, []);

  useEffect(() => {
    window.meetr?.hasDeepgramKey?.().then((ok) => setHasApiKey(Boolean(ok)));
    window.meetr?.hasGroqKey?.().then((ok) => setHasGroqKey(Boolean(ok)));
    window.meetr?.hasOpenRouterKey?.().then((ok) => setHasOpenRouterKey(Boolean(ok)));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('meetr:auto-answer', String(autoAnswerEnabled));
    } catch {
      // Keep the current setting for this session if storage is unavailable.
    }
  }, [autoAnswerEnabled]);

  useEffect(() => {
    if (!window.meetr?.onTranscriptionEvent) return undefined;

    return window.meetr.onTranscriptionEvent((event) => {
      if (!event) return;

      if (event.type === 'final' && event.text) {
        contextRef.current = {
          ...contextRef.current,
          finalLines: [...contextRef.current.finalLines, event.text],
          interim: '',
        };
        setFinalLines((lines) => [...lines, event.text]);
        setInterim('');
        if (listeningRef.current && autoAnswerEnabledRef.current && isVoiceQuestion(event.text)) {
          submitVoiceTranscript(event.text);
        }
      } else if (event.type === 'interim' && event.text) {
        contextRef.current = { ...contextRef.current, interim: event.text };
        setInterim(event.text);
      } else if (event.type === 'status' && event.message) {
        // The socket can open before microphone permission and capture finish.
        setStatus(event.message === 'listening' ? 'connecting' : event.message);
      } else if (event.type === 'error' && event.message) {
        setError(event.message);
        setStatus('error');
      }
    });
  }, [submitVoiceTranscript]);

  useEffect(() => {
    const meetr = window.meetr;
    if (!meetr?.onScreenCapture || !meetr?.onAssistantEvent || !meetr?.onAssistantToken) {
      return undefined;
    }

    const removeScreenCaptureListener = meetr.onScreenCapture(({ imageDataUrl } = {}) => {
      const requestId = ++aiRequestRef.current;
      const context = contextRef.current;
      streamingAnswerRef.current = true;
      setAiMode('screen');
      setSettingsOpen(false);
      setAiAnswer('');
      setDisplayedAnswer('');
      setAiError('');
      setAiState('thinking');

      meetr
        .askOpenRouter({
          requestId,
          imageDataUrl,
          transcript: [...context.finalLines, context.interim].filter(Boolean).join('\n'),
          notes: context.notes,
        })
        .then((answer) => {
          if (requestId !== aiRequestRef.current) return;
          setAiAnswer(answer);
          setAiState('done');
        })
        .catch((error) => {
          if (requestId !== aiRequestRef.current) return;
          setAiError(error?.message || String(error));
          setAiState('error');
        });
    });

    const removeAssistantTokenListener = meetr.onAssistantToken(({ requestId, token } = {}) => {
      if (requestId !== aiRequestRef.current || typeof token !== 'string' || !token) return;
      setAiState('streaming');
      setAiAnswer((answer) => answer + token);
    });

    const removeAssistantEventListener = meetr.onAssistantEvent((event) => {
      if (event?.type === 'capturing') {
        aiRequestRef.current += 1;
        setAiMode('screen');
        setSettingsOpen(false);
        setAiAnswer('');
        setDisplayedAnswer('');
        setAiError('');
        setAiState('capturing');
      } else if (event?.type === 'error') {
        aiRequestRef.current += 1;
        setAiError(event.message || 'Screen capture failed.');
        setAiState('error');
      }
    });

    return () => {
      removeScreenCaptureListener();
      removeAssistantEventListener();
      removeAssistantTokenListener();
    };
  }, []);

  useEffect(() => {
    if (!aiAnswer) {
      setDisplayedAnswer('');
      return undefined;
    }

    if (streamingAnswerRef.current) {
      setDisplayedAnswer(aiAnswer);
      return undefined;
    }

    setDisplayedAnswer('');
    let visibleLength = 0;
    const chunkSize = Math.max(1, Math.ceil(aiAnswer.length / 45));
    const timer = setInterval(() => {
      visibleLength = Math.min(aiAnswer.length, visibleLength + chunkSize);
      setDisplayedAnswer(aiAnswer.slice(0, visibleLength));
      if (visibleLength >= aiAnswer.length) clearInterval(timer);
    }, 16);

    return () => clearInterval(timer);
  }, [aiAnswer]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finalLines, interim]);

  const stopListening = useCallback(async ({ submit = true } = {}) => {
    startingRef.current = false;
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
    try {
      await window.meetr?.stopTranscription?.();
    } catch {
      // no-op
    }
    // Give any final Deepgram result emitted during CloseStream time to update the transcript.
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (submit && autoAnswerEnabledRef.current) submitVoiceTranscript();
    listeningRef.current = false;
    setListening(false);
    setStatus('idle');
    contextRef.current = { ...contextRef.current, interim: '' };
    setInterim('');
  }, [submitVoiceTranscript]);

  const clearTranscript = useCallback(() => {
    contextRef.current = { ...contextRef.current, finalLines: [], interim: '' };
    lastSubmittedTranscriptRef.current = '';
    aiRequestRef.current += 1;
    setFinalLines([]);
    setInterim('');
    setAiAnswer('');
    setDisplayedAnswer('');
    setAiError('');
    setAiState('idle');
  }, []);

  const startListening = useCallback(async () => {
    if (listening || startingRef.current) return;
    startingRef.current = true;
    setError('');
    setStatus('connecting');

    try {
      const meetr = getMeetr();
      const keyed = await meetr.hasDeepgramKey();
      setHasApiKey(keyed);
      if (!keyed) {
        throw new Error('Add DEEPGRAM_API_KEY to your .env file, then restart npm start.');
      }

      await meetr.startTranscription();

      const capture = await startAudioCapture((pcmChunk) => {
        getMeetr().sendAudioChunk(pcmChunk);
      });

      stopCaptureRef.current = capture.stop;
      listeningRef.current = true;
      setListening(true);
      setStatus('listening');
    } catch (err) {
      const message = err?.message || String(err);
      await stopListening({ submit: false });
      setError(message);
      setStatus('error');
    } finally {
      startingRef.current = false;
    }
  }, [listening, stopListening]);

  useEffect(() => {
    return () => {
      stopCaptureRef.current?.();
      window.meetr?.stopTranscription?.();
    };
  }, []);

  const statusLabel = (() => {
    if (error && status === 'error') return 'Error';
    if (listening || status === 'listening') return 'Listening';
    if (status === 'connecting') return 'Connecting…';
    return 'Idle';
  })();

  const statusDot =
    listening || status === 'listening'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : status === 'error'
          ? 'bg-rose-400'
          : 'bg-zinc-500';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      <header className="drag-region flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
            MEETR
          </p>
          <h1 className="truncate text-base font-semibold leading-tight">MEETR AI</h1>
        </div>

        <div className="no-drag flex items-center gap-1.5">
          <button
            type="button"
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] px-2.5 py-1.5 text-xs font-medium transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
          >
            Settings
          </button>
          <button
            type="button"
            title="Hide to tray (Ctrl+Shift+M to show again)"
            aria-label="Hide overlay"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] text-sm leading-none transition hover:border-zinc-400"
            onClick={() => window.meetr?.minimizeWindow?.()}
          >
            –
          </button>
          <button
            type="button"
            title="Close"
            aria-label="Close window"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] text-sm leading-none transition hover:border-rose-400 hover:text-rose-300"
            onClick={() => window.meetr?.closeWindow?.()}
          >
            ×
          </button>
        </div>
      </header>

      <main className="no-drag flex min-h-0 flex-1 flex-col gap-3 p-4">
        {settingsOpen ? (
          <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Notes / Resume
            </h2>
            <label className="mb-3 flex items-start gap-2 text-xs text-[var(--text-primary)]">
              <input
                type="checkbox"
                className="mt-0.5 accent-teal-300"
                checked={autoAnswerEnabled}
                onChange={(event) => setAutoAnswerEnabled(event.target.checked)}
              />
              <span>
                <span className="block font-medium">Auto-send voice questions</span>
                <span className="mt-0.5 block text-[var(--text-muted)]">
                  Finalized spoken questions are sent as transcript text. Pressing Stop sends the
                  latest transcript too. Voice auto-send does not capture the screen.
                </span>
              </span>
            </label>
            <textarea
              className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border-subtle)] bg-black/30 p-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              placeholder="Paste notes or resume context for the AI prompt…"
              value={notes}
              onChange={(event) => {
                contextRef.current = { ...contextRef.current, notes: event.target.value };
                setNotes(event.target.value);
              }}
            />
            {!hasApiKey && (
              <p className="mt-2 text-xs text-amber-300/90">
                Set <code className="text-[var(--accent)]">DEEPGRAM_API_KEY</code> in `.env` and
                restart the app to enable transcription.
              </p>
            )}
            {!hasOpenRouterKey && (
              <p className="mt-2 text-xs text-amber-300/90">
                Add <code className="text-[var(--accent)]">OPENROUTER_API_KEY</code> to `.env` and
                restart the app to enable screen answers.
              </p>
            )}
            {!hasGroqKey && (
              <p className="mt-2 text-xs text-amber-300/90">
                Add <code className="text-[var(--accent)]">GROQ_API_KEY</code> to `.env` and restart
                the app to enable voice answers.
              </p>
            )}
          </section>
        ) : (
          <>
            <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Live transcript
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="Clear transcript"
                    aria-label="Clear transcript"
                    disabled={!finalLines.length && !interim}
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--text-muted)] transition hover:bg-white/5 hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40"
                    onClick={clearTranscript}
                  >
                    Clear
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
                    {statusLabel}
                  </span>
                  <button
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                      listening
                        ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
                        : 'bg-teal-500/20 text-teal-200 hover:bg-teal-500/30'
                    }`}
                    onClick={() => (listening ? stopListening() : startListening())}
                  >
                    {listening ? 'Stop' : 'Listen'}
                  </button>
                </div>
              </div>

              <div
                ref={transcriptRef}
                className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg bg-black/20 p-3 text-sm leading-relaxed"
              >
                {!finalLines.length && !interim && (
                  <p className="text-[var(--text-muted)]">
                    Click Listen to capture microphone speech and computer audio for live captions…
                  </p>
                )}
                {finalLines.map((line, index) => (
                  <p key={`${index}-${line.slice(0, 12)}`} className="text-[var(--text-primary)]">
                    {line}
                  </p>
                ))}
                {interim ? <p className="text-[var(--text-muted)] italic">{interim}</p> : null}
              </div>

              {error ? (
                <p className="mt-2 text-xs text-rose-300/90" role="alert">
                  {error}
                </p>
              ) : null}
            </section>

            <section className="flex max-h-[42%] min-h-[140px] flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel-strong)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Ask AI
                </h2>
                <kbd className="rounded border border-[var(--border-subtle)] bg-black/30 px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                  Shift+Enter
                </kbd>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-black/20 p-3 text-sm leading-relaxed text-[var(--text-muted)]">
                {aiState === 'capturing' ? (
                  <p className="inline-flex items-center gap-2 text-[var(--text-muted)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
                    Capturing screen…
                  </p>
                ) : null}
                {aiState === 'thinking' ? (
                  <p className="inline-flex items-center gap-2 text-[var(--text-muted)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
                    {aiMode === 'voice' ? 'Sending transcript to AI…' : 'Reading screen and context…'}
                  </p>
                ) : null}
                {displayedAnswer ? (
                  <p className="answer-reveal whitespace-pre-wrap text-[var(--text-primary)]">
                    {displayedAnswer}
                    {aiState === 'streaming' ||
                    (aiState === 'done' && displayedAnswer.length < aiAnswer.length) ? (
                      <span className="ml-0.5 animate-pulse text-[var(--accent)]">▍</span>
                    ) : null}
                  </p>
                ) : null}
                {aiError ? (
                  <p className="text-rose-300" role="alert">
                    {aiError}
                  </p>
                ) : null}
                {aiState === 'idle' ? (
                  <p>
                    {hasGroqKey && hasOpenRouterKey
                      ? autoAnswerEnabled
                        ? 'Voice questions use Groq. Press Shift+Enter to analyze the screen with OpenRouter.'
                        : 'Voice answers use Groq when auto-send is enabled. Press Shift+Enter for OpenRouter screen analysis.'
                      : hasGroqKey
                        ? 'Voice answers use Groq. Add OPENROUTER_API_KEY for screen analysis.'
                        : hasOpenRouterKey
                          ? 'Screen answers use OpenRouter. Add GROQ_API_KEY for voice answers.'
                          : 'Add GROQ_API_KEY for voice answers and OPENROUTER_API_KEY for screen analysis, then restart MEETR.'}
                  </p>
                ) : null}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
