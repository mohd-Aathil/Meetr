const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetr', {
  platform: process.platform,

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  captureScreenForAnswer: () => ipcRenderer.invoke('screen:captureForAnswer'),
  getLoopbackSource: () => ipcRenderer.invoke('desktop:getLoopbackSource'),

  hasDeepgramKey: () => ipcRenderer.invoke('transcription:hasApiKey'),
  startTranscription: () => ipcRenderer.invoke('transcription:start'),
  stopTranscription: () => ipcRenderer.invoke('transcription:stop'),
  sendAudioChunk: (chunk) => ipcRenderer.send('transcription:audio', chunk),

  hasGroqKey: () => ipcRenderer.invoke('groq:hasApiKey'),
  askGroq: (payload) => ipcRenderer.invoke('groq:ask', payload),

  hasOpenRouterKey: () => ipcRenderer.invoke('openrouter:hasApiKey'),
  askOpenRouter: (payload) => ipcRenderer.invoke('openrouter:ask', payload),

  onScreenCapture: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('screen:capture', listener);
    return () => ipcRenderer.removeListener('screen:capture', listener);
  },

  onAssistantEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },

  onAssistantToken: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('assistant:token', listener);
    return () => ipcRenderer.removeListener('assistant:token', listener);
  },

  onTranscriptionEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('transcription:event', listener);
    return () => ipcRenderer.removeListener('transcription:event', listener);
  },
});
