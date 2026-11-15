const TARGET_SAMPLE_RATE = 16000;
const PROCESSOR_BUFFER_SIZE = 1024;

/**
 * Capture microphone speech and, when available, desktop loopback audio.
 * @param {(pcmChunk: ArrayBuffer) => void} onPcmChunk
 * @returns {Promise<{ stop: () => void }>}
 */
export async function startAudioCapture(onPcmChunk) {
  if (!window.meetr?.getLoopbackSource) {
    throw new Error('MEETR bridge is unavailable. Restart the Electron app.');
  }

  let microphoneStream;
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
      throw new Error('Microphone access is blocked. Allow MEETR to use the microphone in Windows privacy settings.');
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found. Connect a microphone and try Listen again.');
    }
    throw new Error(`Could not start microphone capture: ${error?.message || String(error)}`);
  }

  const streams = [microphoneStream];
  let systemAudioAvailable = false;

  // Keep system audio when desktop loopback is available. Microphone capture
  // remains usable if loopback is unsupported or unavailable on this machine.
  try {
    const source = await window.meetr.getLoopbackSource();
    const systemStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: 1,
          maxHeight: 1,
        },
      },
    });

    for (const track of systemStream.getVideoTracks()) {
      track.stop();
      systemStream.removeTrack(track);
    }

    if (systemStream.getAudioTracks().length) {
      streams.push(systemStream);
      systemAudioAvailable = true;
    } else {
      systemStream.getTracks().forEach((track) => track.stop());
    }
  } catch {
    // Microphone speech is the essential input; loopback is an enhancement.
  }

  let audioContext;
  try {
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.resume();

    const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      if (downsampled.length) onPcmChunk(floatTo16BitPCM(downsampled));
    };

    const inputGain = audioContext.createGain();
    inputGain.gain.value = systemAudioAvailable ? 0.5 : 1;
    for (const stream of streams) {
      audioContext.createMediaStreamSource(stream).connect(inputGain);
    }

    // Keep the processor in the graph without playing captured audio aloud.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    inputGain.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        inputGain.disconnect();
        silentGain.disconnect();
      } catch {
        // no-op
      }
      streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      if (audioContext.state !== 'closed') audioContext.close();
    };

    return { stop };
  } catch (error) {
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    throw new Error(`Could not start audio processing: ${error?.message || String(error)}`);
  }
}

function downsampleBuffer(buffer, sampleRate, outRate) {
  if (outRate === sampleRate) return buffer;

  const ratio = sampleRate / outRate;
  const newLength = Math.floor(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetBuffer = 0;

  for (let offsetResult = 0; offsetResult < result.length; offsetResult += 1) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}
