// tts-worker.js - Motor Kokoro-82M (WebGPU / WASM) en Web Worker
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts = null;
let activeDevice = null;
let taskQueue = Promise.resolve();

self.onerror = (msg, url, line, col) => {
    postMessage({ type: 'error', message: `Worker Error: ${msg} (${line}:${col})` });
    return false;
};

postMessage({ type: 'worker_started' });
postMessage({ type: 'wasm_ready' });

async function detectBestDevice(preferred) {
    if (preferred === 'wasm' || preferred === 'webgpu') {
        return preferred;
    }
    try {
        if (typeof navigator !== 'undefined' && navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) return 'webgpu';
        }
    } catch (e) {
        console.warn("WebGPU no disponible, usando WASM:", e);
    }
    return 'wasm';
}

async function initKokoro(preferredDevice = 'auto') {
    const targetDevice = await detectBestDevice(preferredDevice);

    if (tts && activeDevice === targetDevice) {
        postMessage({ type: 'model_loaded', device: activeDevice });
        return;
    }

    tts = null;
    activeDevice = null;

    const progressMap = new Map();
    const onProgress = (info) => {
        if (info && info.status === 'progress' && info.file) {
            const pct = typeof info.progress === 'number' ? info.progress : 0;
            progressMap.set(info.file, pct);
            let sum = 0;
            progressMap.forEach((v) => { sum += v; });
            const avg = Math.min(99, Math.round(sum / progressMap.size));
            postMessage({ type: 'download_progress', progress: avg });
        }
    };

    try {
        tts = await KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: "q8",
            device: targetDevice,
            progress_callback: onProgress
        });
        activeDevice = targetDevice;
        postMessage({ type: 'model_loaded', device: activeDevice });
    } catch (err) {
        if (targetDevice === 'webgpu' && preferredDevice === 'auto') {
            console.warn("Fallo al iniciar WebGPU, reintentando con WASM:", err);
            tts = await KokoroTTS.from_pretrained(MODEL_ID, {
                dtype: "q8",
                device: "wasm",
                progress_callback: onProgress
            });
            activeDevice = "wasm";
            postMessage({ type: 'model_loaded', device: activeDevice });
        } else {
            throw err;
        }
    }
}

async function synthesize({ text, voice, rate, requestId }) {
    if (!tts) {
        throw new Error("El modelo Kokoro aún no está cargado.");
    }
    const audio = await tts.generate(text, {
        voice: voice || "ef_dora",
        speed: rate || 1.0
    });

    const samples = audio.audio;
    const sampleRate = audio.sampling_rate || 24000;

    postMessage({
        type: 'generate_done',
        samples,
        sampleRate,
        requestId,
        text
    }, [samples.buffer]);
}

self.onmessage = (e) => {
    const { type, data } = e.data;
    // Serializamos operaciones ONNX para evitar colisiones de sesión concurrente
    taskQueue = taskQueue.then(async () => {
        try {
            if (type === 'load_model') {
                await initKokoro(data?.device || 'auto');
            } else if (type === 'generate') {
                await synthesize(data);
            }
        } catch (err) {
            postMessage({
                type: 'error',
                message: err?.message || String(err),
                requestId: data?.requestId
            });
        }
    });
};
