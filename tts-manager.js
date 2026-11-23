// tts-manager.js - Gestor de Audio Kokoro-82M (WebGPU / WASM)

class TTSManager {
    constructor() {
        this.voices = {
            'es-ES': { name: 'Español (Dora)', voiceId: 'ef_dora' },
            'en-GB': { name: 'Inglés UK (Alice)', voiceId: 'bf_alice' },
            'en-US': { name: 'Inglés US (Heart)', voiceId: 'af_heart' }
        };

        this.worker = null;
        this.audioContext = null;
        this.currentSource = null;

        this.isWorkerBooted = false;
        this.isWasmReady = false;
        this.isModelLoaded = false;
        this.currentLang = 'es-ES';
        this.currentDevice = localStorage.getItem('ttsDevice') || 'auto';
        this.activeBackend = null;

        this._pendingSpeak = null;
        this._pregeneratedAudios = new Map();
        this._messageQueue = [];
        this._requestIdCounter = 0;

        this.initWorker();
    }

    initWorker() {
        if (this.worker) this.worker.terminate();
        this.worker = new Worker('./tts-worker.js?v=' + Date.now(), { type: 'module' });

        this.worker.onmessage = (e) => {
            const { type, samples, sampleRate, text, device, message, progress, requestId } = e.data;

            switch (type) {
                case 'worker_started':
                    this.isWorkerBooted = true;
                    break;
                case 'wasm_ready':
                    this.isWasmReady = true;
                    this.processQueue();
                    break;
                case 'download_progress':
                    this.updateProgressUI(progress);
                    break;
                case 'model_loaded':
                    this.isModelLoaded = true;
                    this.activeBackend = device || 'wasm';
                    this.updateStatusBadge(this.currentLang, this.activeBackend);
                    break;
                case 'generate_done':
                    this.handleWorkerAudio(samples, sampleRate, text, requestId);
                    break;
                case 'error':
                    console.error("TTS Error:", message);
                    this.handleError(message);
                    break;
            }
        };

        this.worker.onerror = (err) => {
            console.error("Worker crash:", err);
            this.handleError(err.message || "Error en Worker");
        };
    }

    updateProgressUI(percent) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.style.setProperty('--download-progress', `${percent}%`);
            statusBadge.innerHTML = `<span class="spinner"></span> Cargando Kokoro... ${percent}%`;
            statusBadge.classList.add('loading');
            statusBadge.classList.remove('ready');
        }
    }

    updateStatusBadge(lang, backend) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.classList.remove('loading');
            statusBadge.style.setProperty('--download-progress', `100%`);
            const tag = backend ? backend.toUpperCase() : 'OK';
            statusBadge.innerHTML = `<span style="color:#22c55e;">●</span> Kokoro (${lang} · ${tag})`;
            statusBadge.classList.add('ready');
        }
    }

    handleError(msg) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.innerHTML = `<span style="color:#ef4444;">●</span> Error Voz`;
            statusBadge.classList.remove('loading');
        }
    }

    processQueue() {
        while (this._messageQueue.length > 0) {
            this.worker.postMessage(this._messageQueue.shift());
        }
    }

    async loadModel(lang, deviceOverride = null) {
        const nextLang = this.voices[lang] ? lang : 'es-ES';
        const nextDevice = deviceOverride || this.currentDevice || 'auto';

        const langChanged = this.currentLang !== nextLang;
        const deviceChanged = deviceOverride !== null && deviceOverride !== this.currentDevice;

        this.currentLang = nextLang;
        if (deviceOverride !== null) {
            this.currentDevice = nextDevice;
        }

        if (langChanged || deviceChanged) {
            this._pregeneratedAudios.clear();
        }

        // Si el modelo ya está cargado y no ha cambiado el backend, cambiar de idioma/voz es instantáneo
        if (this.isModelLoaded && !deviceChanged) {
            this.updateStatusBadge(this.currentLang, this.activeBackend);
            return true;
        }

        this.isModelLoaded = false;
        this.updateProgressUI(0);

        const msg = {
            type: 'load_model',
            data: { device: nextDevice }
        };

        if (this.isWasmReady) {
            this.worker.postMessage(msg);
        } else {
            this._messageQueue.push(msg);
        }
        return true;
    }

    _getVoiceId() {
        return (this.voices[this.currentLang] || this.voices['es-ES']).voiceId;
    }

    _cacheKey(text, rate) {
        return `${this.currentLang}|${rate}|${text}`;
    }

    handleWorkerAudio(samples, sampleRate, text, requestId) {
        if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);

        if (this._pendingSpeak && this._pendingSpeak.requestId === requestId) {
            const callback = this._pendingSpeak.onEnd;
            this._pendingSpeak = null;
            this.playBuffer(buffer, callback);
        } else {
            // Look-ahead: guardamos con la clave del idioma/velocidad actual
            this._pregeneratedAudios.set(this._cacheKey(text, this._lastPregenRate || 1.0), buffer);
            if (this._pregeneratedAudios.size > 15) {
                const firstKey = this._pregeneratedAudios.keys().next().value;
                this._pregeneratedAudios.delete(firstKey);
            }
        }
    }

    async speak(text, rate = 1.0, onEndCallback) {
        if (!this.isModelLoaded) return false;
        this.stop();

        const key = this._cacheKey(text, rate);
        if (this._pregeneratedAudios.has(key)) {
            const buffer = this._pregeneratedAudios.get(key);
            this._pregeneratedAudios.delete(key);
            this.playBuffer(buffer, onEndCallback);
            return true;
        }

        const requestId = ++this._requestIdCounter;
        this._pendingSpeak = { text, onEnd: onEndCallback, requestId };
        this.worker.postMessage({
            type: 'generate',
            data: { text, voice: this._getVoiceId(), rate, requestId }
        });
        return true;
    }

    pregenerate(text, rate = 1.0) {
        if (!this.isModelLoaded || !text || text.length < 2) return;
        const key = this._cacheKey(text, rate);
        if (this._pregeneratedAudios.has(key)) return;

        this._lastPregenRate = rate;
        const requestId = ++this._requestIdCounter;
        this.worker.postMessage({
            type: 'generate',
            data: { text, voice: this._getVoiceId(), rate, requestId }
        });
    }

    async playBuffer(buffer, onEndCallback) {
        if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);

        this.currentSource = source;
        source.onended = () => {
            if (this.currentSource === source) {
                this.currentSource = null;
                if (onEndCallback) onEndCallback();
            }
        };
        source.start();
    }

    stop() {
        this._pendingSpeak = null;
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch (e) {}
            this.currentSource = null;
        }
    }
}

window.ttsManager = new TTSManager();
