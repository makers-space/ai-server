import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { Ollama } from 'ollama';

const ERROR_TABLE = {
    OLLAMA_DOWN: {
        status: 503,
        message: 'Ollama is not running on this device.',
        action: 'Start Ollama, then check again.'
    },
    MODEL_MISSING: {
        status: 404,
        message: 'This model is not installed on this device.',
        action: 'Download the model first.'
    },
    MODEL_NOT_FOUND: {
        status: 404,
        message: 'No model with this name could be found.',
        action: 'Check the spelling. A model name looks like llama3.2:3b.'
    },
    MODEL_TOO_LARGE: {
        status: 422,
        message: 'This model is too large for this device.',
        action: 'Pick a smaller model. The Discover tab shows which ones fit.'
    },
    OUT_OF_MEMORY: {
        status: 422,
        message: 'This model needs more memory than this device has free.',
        action: 'Unload other models or pick a smaller one.'
    },
    DISK_FULL: {
        status: 422,
        message: 'There is not enough disk space on this device.',
        action: 'Remove a model you no longer use, then try again.'
    },
    DOWNLOAD_INTERRUPTED: {
        status: 502,
        message: 'The download stopped before it finished.',
        action: 'Resume the download. It continues from where it stopped.'
    },
    NO_TOOL_SUPPORT: {
        status: 422,
        message: 'This model cannot use tools.',
        action: 'Pick a model that supports tools.'
    },
    TOO_LONG: {
        status: 422,
        message: 'The conversation is too long for this model.',
        action: 'Start a new chat, or pick a model that can read more.'
    },
    UNKNOWN: {
        status: 502,
        message: 'Ollama reported a problem it did not explain.',
        action: 'Try again. If it keeps happening, restart Ollama.'
    }
};

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

const RULES = [
    ['DISK_FULL', /no space left|not enough (disk )?space|insufficient disk/i],
    ['OUT_OF_MEMORY', /requires more system memory|out of memory|insufficient memory|not enough memory|cuda error.*memory/i],
    ['NO_TOOL_SUPPORT', /does not support tools/i],
    ['TOO_LONG', /context length|context window|exceeds? (the )?(maximum )?context|prompt is too long/i],
    ['DOWNLOAD_INTERRUPTED', /unexpected eof|connection reset|stalled|max retries exceeded|pull.*interrupted/i],
    ['MODEL_MISSING', /model.*not found|not found.*model|try pulling it first|file does not exist|manifest.*(unknown|not found)/i]
];

export class OllamaError extends Error {
    constructor(code, detail = null) {
        const entry = ERROR_TABLE[code] || ERROR_TABLE.UNKNOWN;
        super(entry.message);
        this.name = 'OllamaError';
        this.code = ERROR_TABLE[code] ? code : 'UNKNOWN';
        this.status = entry.status;
        this.action = entry.action;
        this.detail = detail;
    }

    toJSON() {
        return { code: this.code, message: this.message, action: this.action };
    }
}

export const mapOllamaError = (error) => {
    if (error instanceof OllamaError) return error;

    const text = String(error?.error || error?.message || '');
    const causeCode = error?.cause?.code || error?.code;

    if (CONNECTION_CODES.has(causeCode) || /fetch failed|timed out waiting for ollama/i.test(text)) {
        return new OllamaError('OLLAMA_DOWN', text);
    }
    for (const [code, pattern] of RULES) {
        if (pattern.test(text)) return new OllamaError(code, text);
    }
    if (error?.status_code === 404) return new OllamaError('MODEL_MISSING', text);

    return new OllamaError('UNKNOWN', text);
};

export const ERROR_CODES = Object.keys(ERROR_TABLE);

const STATUS_TIMEOUT_MS = 3000;

const defaultFactory = (host) => new Ollama({ host });
let clientFactory = defaultFactory;

export const setOllamaClientFactory = (factory) => {
    clientFactory = factory;
};

export const resetOllamaClientFactory = () => {
    clientFactory = defaultFactory;
};

const withTimeout = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for Ollama')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const createOllamaClient = (host) => {
    const call = async (run) => {
        try {
            return await run(clientFactory(host));
        } catch (error) {
            throw mapOllamaError(error);
        }
    };

    return {
        host,

        async status() {
            try {
                const { version } = await withTimeout(clientFactory(host).version(), STATUS_TIMEOUT_MS);
                return { available: true, version };
            } catch {
                return { available: false, version: null };
            }
        },

        list: () => call((client) => client.list()),
        running: () => call((client) => client.ps()),
        show: (model) => call((client) => client.show({ model })),
        remove: (model) => call((client) => client.delete({ model })),
        create: (request) => call((client) => client.create(request)),
        pull: (model) => call((client) => client.pull({ model, stream: true })),
        chat: (request) => call((client) => client.chat(request)),
        unload: (model) => call((client) => client.generate({ model, prompt: '', keep_alive: 0 }))
    };
};

const MB = 1024 * 1024;

export const parseNvidiaSmi = (text) =>
    String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, total] = line.split(',').map((part) => part.trim());
            const memoryMb = Number(total);
            if (!name || !Number.isFinite(memoryMb) || memoryMb <= 0) return null;
            return { name, memoryMb };
        })
        .filter(Boolean);

const readNvidiaSmi = () =>
    new Promise((resolve) => {
        execFile(
            'nvidia-smi',
            ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
            { timeout: 5000, windowsHide: true },
            (error, stdout) => resolve(error ? '' : stdout)
        );
    });

export const modelsFolder = () => process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');

export const readDisk = async () => {
    for (const folder of [modelsFolder(), os.homedir()]) {
        try {
            const stats = await statfs(folder);
            return {
                diskFreeMb: Math.round((stats.bavail * stats.bsize) / MB),
                diskTotalMb: Math.round((stats.blocks * stats.bsize) / MB)
            };
        } catch {
            continue;
        }
    }
    return { diskFreeMb: null, diskTotalMb: null };
};

export const detectHardware = async () => {
    const [gpus, disk] = await Promise.all([readNvidiaSmi().then(parseNvidiaSmi), readDisk()]);
    const cpus = os.cpus();

    return {
        hostname: os.hostname(),
        platform: process.platform,
        cpu: cpus[0]?.model?.trim() || null,
        cpuThreads: cpus.length,
        memoryMb: Math.round(os.totalmem() / MB),
        gpus,
        gpuMemoryMb: gpus.reduce((largest, gpu) => Math.max(largest, gpu.memoryMb), 0),
        ...disk,
        modelsPath: modelsFolder(),
        detectedAt: new Date()
    };
};

export const GPU_HEADROOM_MB = 1536;
export const RAM_RESERVE_MB = 4096;

export const VERDICTS = {
    gpu: 'Runs fully on GPU',
    mixed: 'Runs with CPU help (slower)',
    cpu: 'Runs on the processor (slower)',
    too_large: 'Too large for this device'
};

export const memoryNeededMb = (entry) => Math.round(entry.sizeMb * 1.1 + 800);

const speedRange = (verdict, entry) => {
    const size = entry.parameters;
    if (verdict === 'gpu') {
        if (size <= 4.5) return [60, 120];
        if (size <= 9) return [35, 70];
        if (size <= 15) return [20, 40];
        if (size <= 33) return [12, 28];
        return [6, 14];
    }
    if (verdict === 'mixed') {
        if (entry.moe) return [15, 35];
        if (size <= 9) return [8, 20];
        if (size <= 15) return [4, 10];
        return [1, 5];
    }
    if (verdict === 'cpu') {
        if (size <= 4.5) return [8, 20];
        if (size <= 9) return [3, 8];
        return [1, 4];
    }
    return null;
};

export const fitModel = (entry, hardware) => {
    const gpuMemoryMb = Number(hardware?.gpuMemoryMb) || 0;
    const memoryMb = Number(hardware?.memoryMb) || 0;
    const hasGpu = gpuMemoryMb > 0;
    const usableGpu = hasGpu ? Math.max(0, gpuMemoryMb - GPU_HEADROOM_MB) : 0;
    const usableRam = Math.max(0, memoryMb - RAM_RESERVE_MB);
    const needed = memoryNeededMb(entry);

    let verdict = 'too_large';
    if (hasGpu && needed <= usableGpu) verdict = 'gpu';
    else if (hasGpu && needed <= usableGpu + usableRam) verdict = 'mixed';
    else if (!hasGpu && needed <= usableRam) verdict = 'cpu';

    return {
        verdict,
        label: VERDICTS[verdict],
        fits: verdict !== 'too_large',
        memoryNeededMb: needed,
        tokensPerSecond: speedRange(verdict, entry)
    };
};

const byParameters = (a, b) => a.parameters - b.parameters;
const general = (entry) => entry.goodFor.includes('chat');

export const rankCatalogue = (catalogue, hardware) => {
    const entries = catalogue.map((entry) => ({ ...entry, fit: fitModel(entry, hardware), pick: null }));
    const lowestSpeed = (entry) => entry.fit.tokensPerSecond?.[0] ?? 0;
    let pool = entries.filter((entry) => entry.fit.verdict === 'gpu' || entry.fit.verdict === 'cpu');
    if (pool.length === 0) pool = entries.filter((entry) => entry.fit.verdict === 'mixed');
    pool = pool.filter((entry) => lowestSpeed(entry) >= 3).sort(byParameters);
    const base = pool.some(general) ? pool.filter(general) : pool;

    const fast = base[0] || null;
    const carried = entries
        .filter((entry) => entry.fit.verdict === 'mixed' && entry.moe && !pool.includes(entry))
        .sort((x, y) => byParameters(y, x));
    const best = carried.find(general) || carried[0] || (base.length > 1 ? base[base.length - 1] : null);
    const rest = base.filter((entry) => entry !== fast && entry !== best);
    const balanced = [...rest].reverse().find((entry) => lowestSpeed(entry) >= 20) || rest[rest.length - 1] || null;

    if (fast) fast.pick = 'fast';
    if (balanced) balanced.pick = 'balanced';
    if (best) best.pick = 'best';

    const order = { fast: 0, balanced: 1, best: 2 };
    return entries.sort((a, b) => {
        const pickA = a.pick ? order[a.pick] : 9;
        const pickB = b.pick ? order[b.pick] : 9;
        if (pickA !== pickB) return pickA - pickB;
        if (a.fit.fits !== b.fit.fits) return a.fit.fits ? -1 : 1;
        return byParameters(a, b);
    });
};
