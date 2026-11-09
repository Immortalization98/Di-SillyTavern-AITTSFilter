// TEST ONLY. Registers a TTS provider that records the text it is asked to
// speak (window.__mockTtsLog) and returns a short silent WAV.
import { registerTtsProvider } from '../../tts/index.js';

window.__mockTtsLog = [];

function silentWav(seconds) {
    const rate = 8000;
    const samples = Math.max(1, Math.round(rate * seconds));
    const buffer = new ArrayBuffer(44 + samples);
    const v = new DataView(buffer);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, samples, true);
    new Uint8Array(buffer, 44).fill(128);
    return new Blob([buffer], { type: 'audio/wav' });
}

class MockRecorderProvider {
    settings = { voiceMap: {} };
    voices = [];
    separator = ' . ';
    get settingsHtml() { return '<div>Mock TTS Recorder (test only)</div>'; }
    async loadSettings(settings) { this.settings = { voiceMap: {}, ...settings }; }
    onSettingsChange() { }
    async checkReady() { this.voices = await this.fetchTtsVoiceObjects(); }
    async onRefreshClick() { }
    async getVoice(name) {
        const v = (await this.fetchTtsVoiceObjects()).find(x => x.name === name);
        if (!v) throw `voice ${name} not found`;
        return v;
    }
    async fetchTtsVoiceObjects() {
        return ['alpha', 'beta'].map(n => ({ name: n, voice_id: n, lang: 'zh-CN' }));
    }
    async previewTtsVoice() { }
    async generateTts(text, voiceId) {
        window.__mockTtsLog.push({ text, voiceId, at: Date.now() });
        const seconds = Math.min(3, 0.4 + Array.from(text).length * 0.02);
        return new Response(silentWav(seconds), { headers: { 'content-type': 'audio/wav' } });
    }
}

registerTtsProvider('Mock Recorder', MockRecorderProvider);
