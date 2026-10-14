import { loadPcmWorklet, PCM_WORKLET_NAME } from './pcm-worklet';
import { buildTranscriptionConfig } from './transcription';

const LIVE_MODEL = 'gemini-3.5-transcribe-live';
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600;
const MAX_LISTEN_MS = 30_000;
const FINAL_WAIT_MS = 2_500;
const CONNECT_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000;

export type VoiceStatus =
  | 'connecting'
  | 'listening'
  | 'finalizing'
  | 'stopped'
  | 'cancelled'
  | 'error';

export type VoiceCallbacks = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus: (status: VoiceStatus, message?: string) => void;
};

export type MicSessionController = {
  stop: () => void;
  cancel: () => void;
};

type LiveSession = {
  sendRealtimeInput: (params: {
    media?: { mimeType: string; data: string };
    audioStreamEnd?: boolean;
  }) => void;
  conn: { close?: () => void };
};

type LiveServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string; finished?: boolean };
  };
};

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const BLOCK = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + BLOCK, bytes.length)));
  }
  return window.btoa(binary);
}

async function fetchToken(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch('/api/token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    let payload: { token?: string; error?: string } = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(payload.error || `Token request failed (${response.status})`);
    }
    if (!payload.token) throw new Error('Token request returned no token');
    return payload.token;
  } finally {
    clearTimeout(timer);
  }
}

export function startMicSession(callbacks: VoiceCallbacks): MicSessionController {
  let settled = false;
  let aborted = false;
  let finalText = '';
  let interimText = '';
  let session: LiveSession | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let liveStream: MediaStream | null = null;
  let closedByUs = false;
  let listenTimer: ReturnType<typeof setTimeout> | null = null;

  function onPageHidden() {
    if (settled || aborted) return;
    cancelNow('Recording cancelled.');
  }
  function onVisibilityChange() {
    if (document.hidden && !settled && !aborted) cancelNow('Recording cancelled.');
  }
  function detachLifecycle() {
    document.removeEventListener('pagehide', onPageHidden);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  document.addEventListener('pagehide', onPageHidden);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const { onInterim, onFinal, onStatus } = callbacks;

  function cleanup() {
    detachLifecycle();
    try {
      liveStream?.getTracks().forEach(track => track.stop());
    } catch {}
    liveStream = null;
    try {
      workletNode?.disconnect();
    } catch {}
    workletNode = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => {});
    }
    audioContext = null;
  }

  function finish(final: string, status: VoiceStatus, message?: string) {
    if (settled) return;
    settled = true;
    cleanup();
    if (session && !closedByUs) {
      try {
        session.conn.close?.();
      } catch {}
    }
    session = null;
    if (status === 'cancelled') {
      onStatus('cancelled', message);
      return;
    }
    if (status === 'error') {
      onStatus('error', message || 'Voice recognition failed.');
      return;
    }
    if (final) {
      finalText = final;
      onFinal(final);
      onStatus('stopped');
      return;
    }
    if (interimText) {
      onFinal(interimText);
      onStatus('stopped');
      return;
    }
    onFinal('');
    onStatus('stopped');
  }

  function cancelNow(reason: string) {
    if (settled) return;
    aborted = true;
    finish('', 'cancelled', reason);
  }

  async function run() {
    try {
      if (!window.isSecureContext) {
        finish('', 'error', 'Microphone requires a secure connection (HTTPS).');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        finish('', 'error', 'Microphone access is not supported by this browser.');
        return;
      }
      if (!window.AudioContext && !(window as any).webkitAudioContext) {
        finish('', 'error', 'Audio playback is not supported in this browser.');
        return;
      }
      if (!window.AudioWorkletNode) {
        finish('', 'error', 'This browser cannot stream audio for live transcription.');
        return;
      }

      onStatus('connecting');
      const token = await fetchToken();
      if (aborted || settled) return;

      const { GoogleGenAI } = await import('@google/genai');
      if (aborted || settled) return;

      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: 'v1alpha' },
      });

      session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: ['TEXT'] as any,
          // Mirrors the transcription config locked into the ephemeral token so
          // the recognizer is biased toward the configured accents and terms.
          inputAudioTranscription: buildTranscriptionConfig() as any,
        },
        callbacks: {
          onopen: () => {},
          onmessage: (event: LiveServerMessage) => {
            if (settled) {
              if (event.serverContent?.inputTranscription?.text) finalText = event.serverContent.inputTranscription.text;
              return;
            }
            const content = event.serverContent;
            if (!content) return;
            const interim = content.interimInputTranscription?.text;
            if (interim) {
              interimText = interim;
              onInterim(interim);
            }
            if (content.inputTranscription?.text) {
              finalText = content.inputTranscription.text;
              interimText = finalText;
              onInterim(finalText);
            }
          },
          onerror: () => {},
          onclose: () => {
            if (settled || aborted || closedByUs) return;
            finish('', 'error', 'Connection lost — check your network and try again.');
          },
        },
      });

      const connectComplete = await new Promise<boolean>(resolve => {
        const started = Date.now();
        const poll = () => {
          if (settled || aborted) return resolve(false);
          if ((session as any).setupComplete) return resolve(true);
          if (Date.now() - started > CONNECT_TIMEOUT_MS) return resolve(false);
          setTimeout(poll, 50);
        };
        poll();
      });
      if (!connectComplete) {
        session.conn.close?.();
        finish('', 'error', 'Could not start the live listening session.');
        return;
      }

      if (aborted || settled) return;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error: any) {
        const name = error?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          finish('', 'error', 'Microphone permission was denied. Allow it and try again.');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          finish('', 'error', 'No microphone was found.');
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          finish('', 'error', 'The microphone is in use by another app.');
        } else {
          finish('', 'error', 'Could not access the microphone.');
        }
        return;
      }
      if (aborted || settled) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      liveStream = stream;
      stream.getTracks().forEach(track => {
        track.onended = () => {
          if (settled || aborted) return;
          finish('', 'cancelled', 'Recording cancelled.');
        };
      });

      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx() as AudioContext;
      audioContext = ctx;
      await loadPcmWorklet(ctx, TARGET_RATE);
      if (aborted || settled) return;

      const source = ctx.createMediaStreamSource(stream);
      workletNode = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: TARGET_RATE, chunkSamples: CHUNK_SAMPLES },
      });
      workletNode.port.onmessage = (event: MessageEvent) => {
        const samples = event.data?.samples as Int16Array | undefined;
        if (!samples || samples.length === 0 || settled) return;
        if (!session) return;
        try {
          session.sendRealtimeInput({
            media: { mimeType: `audio/pcm;rate=${TARGET_RATE}`, data: int16ToBase64(samples) },
          });
        } catch {
          // Socket closed between frames; the onclose handler reports it.
        }
      };
      source.connect(workletNode);

      onStatus('listening');
      listenTimer = setTimeout(() => {
        if (!settled && !aborted) void stop();
      }, MAX_LISTEN_MS);
    } catch (error: any) {
      if (settled || aborted) return;
      finish('', 'error', error instanceof Error ? 'Could not start voice recognition. Please try again.' : 'Could not start voice recognition.');
    }
  }

  async function stop() {
    if (settled || aborted) return;
    aborted = true;
    onStatus('finalizing');
    cleanup();
    if (listenTimer) clearTimeout(listenTimer);
    listenTimer = null;

    await new Promise(resolve => setTimeout(resolve, 40));

    const finalPromise = new Promise<string | null>(resolve => {
      const start = Date.now();
      let fired = false;
      const poll = () => {
        if (finalText && !fired) {
          fired = true;
          resolve(finalText);
        } else if (Date.now() - start > FINAL_WAIT_MS) {
          fired = true;
          resolve(null);
        } else {
          setTimeout(poll, 60);
        }
      };
      if (session) {
        try {
          session.sendRealtimeInput({ audioStreamEnd: true });
        } catch {}
      }
      poll();
    });

    const final = await finalPromise;
    if (session) {
      closedByUs = true;
      try {
        session.conn.close?.();
      } catch {}
      session = null;
    }
    finish(final || '', 'stopped');
  }

  function cancel() {
    if (settled) return;
    if (listenTimer) clearTimeout(listenTimer);
    listenTimer = null;
    cancelNow('Recording cancelled.');
  }

  void run();

  return { stop, cancel };
}