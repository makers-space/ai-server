import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statfs, readFile, readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
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
    NO_MODELS: {
        status: 409,
        message: 'No model is installed on this device yet.',
        action: 'Download one on the Models page.'
    },
    QUEUE_FULL: {
        status: 429,
        message: 'You already have 5 requests waiting for the model.',
        action: 'Wait for one to finish, then try again.'
    },
    CHAT_FULL: {
        status: 422,
        message: 'This chat has reached its limit of 200 messages.',
        action: 'Start a new chat from a summary.'
    },
    DOCUMENT_TOO_LONG: {
        status: 422,
        message: 'This document is longer than this model can read.',
        action: 'Use a shorter document, or pick a model that can read more.'
    },
    FILE_TOO_LARGE: {
        status: 413,
        message: 'This file is larger than 20 MB.',
        action: 'Use a smaller file.'
    },
    FILE_UNREADABLE: {
        status: 415,
        message: 'This kind of file cannot be read as text.',
        action: 'Use a text, Markdown, CSV, PDF or Word (.docx) file.'
    },
    FILE_NOT_FOUND: {
        status: 404,
        message: 'This file could not be found, or you do not have access to it.',
        action: 'Pick another file.'
    },
    FILE_NOT_SAVED: {
        status: 403,
        message: 'The file could not be saved in this folder.',
        action: 'Pick a folder you are allowed to add files to.'
    },
    FILES_DOWN: {
        status: 503,
        message: 'Your files are not available right now.',
        action: 'Check that FilesystemOne is running. Everything else keeps working.'
    },
    REMOTE_BLOCKED: {
        status: 400,
        message: 'This address cannot be loaded.',
        action: 'Only public https addresses can be shown.'
    },
    REMOTE_FAILED: {
        status: 502,
        message: 'The file could not be loaded from its address.',
        action: 'Check the address, or open it in a new tab.'
    },
    SEARCH_DOWN: {
        status: 502,
        message: 'The search service could not be reached.',
        action: 'Check the search service set on the server.'
    },
    SEARCH_LIMITED: {
        status: 503,
        message: 'The search service is limiting requests right now.',
        action: 'Wait a few minutes before searching again.'
    },
    SEARCH_REFUSED: {
        status: 502,
        message: 'The search service refused the request.',
        action: 'Check the search key or settings on the server.'
    },
    REMOTE_NOT_FOUND: {
        status: 404,
        message: 'Nothing exists at this address.',
        action: 'The address may have been written from memory instead of found. Ask the model to search for the file again.'
    },
    REMOTE_BUSY: {
        status: 503,
        message: 'The site is limiting how often its files can be loaded.',
        action: 'Wait a moment and try again, or open the address in a new tab.'
    },
    REMOTE_TOO_LARGE: {
        status: 413,
        message: 'This file is larger than 50 MB.',
        action: 'Open it in a new tab instead.'
    },
    NO_DEVICE: {
        status: 503,
        message: 'No device is connected to your account.',
        action: 'Open the Mollama desktop app on a computer and sign in.'
    },
    DEVICE_OFFLINE: {
        status: 503,
        message: 'This device is not connected right now.',
        action: 'Open the Mollama desktop app on that computer, or pick another device.'
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

const defaultFactory = (host, fetchThrough = null) => new Ollama(fetchThrough ? { host, fetch: fetchThrough } : { host });
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

export const createOllamaClient = (host, fetchThrough = null) => {
    const make = () => (fetchThrough ? defaultFactory(host, fetchThrough) : clientFactory(host));
    const call = async (run) => {
        try {
            return await run(make());
        } catch (error) {
            throw mapOllamaError(error);
        }
    };

    return {
        host,

        async status() {
            try {
                const { version } = await withTimeout(make().version(), STATUS_TIMEOUT_MS);
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
        unload: (model) => call((client) => client.generate({ model, prompt: '', keep_alive: 0 })),
        load: (model, keepAlive, numCtx) => call((client) => client.generate({ model, prompt: '', keep_alive: keepAlive, options: { num_ctx: numCtx } }))
    };
};

// Holds the live connection from each signed-in desktop app and carries Ollama requests to it.
// A request travels as { id, type: 'request', method, path, headers, body } and comes back as
// 'head', then 'chunk' messages (base64), then 'end'; 'ask' fetches hardware or disk details.
export class DeviceGateway extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.devices = new Map();
        this.counter = 0;
        this.helloMs = 10000;
        this.askMs = 15000;
    }

    isOnline(deviceId) {
        return this.devices.has(String(deviceId));
    }

    handleConnection(ws, verify) {
        const timer = setTimeout(() => ws.close(1008, 'No hello'), this.helloMs);
        timer.unref?.();
        ws.once('message', async (raw) => {
            clearTimeout(timer);
            let hello = null;
            try {
                hello = JSON.parse(String(raw));
            } catch {
                hello = null;
            }
            const deviceId = hello ? await Promise.resolve(verify(hello)).catch(() => null) : null;
            if (!deviceId) return ws.close(1008, 'Device not recognised');
            return this.attach(String(deviceId), ws, hello);
        });
    }

    attach(deviceId, ws, hello = {}) {
        const entry = { ws, pending: new Map() };
        const earlier = this.devices.get(deviceId);
        this.devices.set(deviceId, entry);
        earlier?.ws.close(1000, 'Replaced');

        ws.on('message', (raw) => {
            let message = null;
            try {
                message = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (message.type === 'goodbye') {
                entry.leaving = true;
                return;
            }
            entry.pending.get(String(message.id))?.[message.type]?.(message);
        });
        ws.on('close', () => {
            const current = this.devices.get(deviceId) === entry;
            if (current) this.devices.delete(deviceId);
            for (const waiting of [...entry.pending.values()]) waiting.fail();
            if (current) this.emit(entry.leaving ? 'goodbye' : 'offline', deviceId);
        });
        ws.on('error', () => {});

        this.send(entry, { type: 'welcome' });
        this.emit('online', deviceId, hello);
    }

    send(entry, message) {
        try {
            entry.ws.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    disconnect(deviceId) {
        this.devices.get(String(deviceId))?.ws.close(1000, 'Removed');
    }

    ask(deviceId, what) {
        return new Promise((resolve, reject) => {
            const entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));
            const id = String(++this.counter);
            const timer = setTimeout(() => finish(() => reject(new OllamaError('DEVICE_OFFLINE'))), this.askMs);
            timer.unref?.();
            const finish = (settle) => {
                clearTimeout(timer);
                entry.pending.delete(id);
                settle();
            };
            entry.pending.set(id, {
                answer: (message) => finish(() => resolve(message.data)),
                error: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE'))),
                fail: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE')))
            });
            if (!this.send(entry, { id, type: 'ask', what })) entry.pending.get(id)?.fail();
            return undefined;
        });
    }

    fetcher(deviceId) {
        return (input, init = {}) => new Promise((resolve, reject) => {
            const entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));

            const id = String(++this.counter);
            const url = new URL(typeof input === 'string' ? input : input.url);
            let controller = null;
            let answered = false;
            const drop = (error) => {
                if (!entry.pending.delete(id)) return;
                if (answered) {
                    try {
                        controller.error(error);
                    } catch { /* already closed */ }
                } else {
                    reject(error);
                }
            };
            const cancel = () => {
                if (entry.pending.has(id)) this.send(entry, { id, type: 'cancel' });
            };
            const stream = new ReadableStream({
                start: (given) => { controller = given; },
                cancel: () => {
                    cancel();
                    entry.pending.delete(id);
                }
            });

            entry.pending.set(id, {
                head: (message) => {
                    answered = true;
                    const empty = [204, 205, 304].includes(message.status);
                    if (empty) entry.pending.delete(id);
                    resolve(new Response(empty ? null : stream, { status: message.status, headers: message.headers || {} }));
                },
                chunk: (message) => {
                    try {
                        controller.enqueue(new Uint8Array(Buffer.from(message.data, 'base64')));
                    } catch { /* reader gone */ }
                },
                end: () => {
                    entry.pending.delete(id);
                    try {
                        controller.close();
                    } catch { /* already closed */ }
                },
                error: (message) => drop(message.code === 'OLLAMA_DOWN' ? new OllamaError('OLLAMA_DOWN') : new OllamaError('DEVICE_OFFLINE')),
                fail: () => drop(new OllamaError('DEVICE_OFFLINE'))
            });

            init.signal?.addEventListener('abort', () => {
                cancel();
                drop(new DOMException('This operation was aborted', 'AbortError'));
            }, { once: true });

            const headers = {};
            new Headers(init.headers || {}).forEach((value, name) => { headers[name] = value; });
            const sent = this.send(entry, {
                id,
                type: 'request',
                method: init.method || 'GET',
                path: url.pathname + url.search,
                headers,
                body: init.body === undefined || init.body === null ? undefined : String(init.body)
            });
            if (!sent) entry.pending.get(id)?.fail();
            return undefined;
        });
    }
}

export const deviceGateway = new DeviceGateway();

const MB = 1024 * 1024;

// Graphics a model can run on, checked a different way on each kind of machine:
// Nvidia cards anywhere, the built-in graphics of an Apple-chip Mac, and AMD cards on Windows and Linux.
// Anything else reports no usable graphics, so models are sized for the processor and system memory.
const APPLE_GRAPHICS_SHARE = 2 / 3;
const SMALLEST_USEFUL_CARD_MB = 2048;
const DISPLAY_ADAPTERS = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Select-Object DriverDesc, 'HardwareInformation.qwMemorySize' | ConvertTo-Json -Compress";

const runQuietly = (file, args) => new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

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

// An Apple chip's graphics share the system memory; about two thirds of it can hold a model.
export const appleGpus = ({ platform, arch, cpu, memoryMb }) => (platform === 'darwin' && arch === 'arm64' && memoryMb > 0
    ? [{ name: `${cpu || 'Apple chip'} built-in graphics`, memoryMb: Math.round(memoryMb * APPLE_GRAPHICS_SHARE) }]
    : []);

// Windows lists every display adapter with its own memory; only AMD cards with real memory of their own count here.
export const parseDisplayAdapters = (text) => {
    let rows = [];
    try {
        rows = JSON.parse(String(text || '').trim() || '[]');
    } catch {
        return [];
    }
    return (Array.isArray(rows) ? rows : [rows]).map((row) => {
        const name = String(row?.DriverDesc || '').trim();
        const memoryMb = Math.round(Number(row?.['HardwareInformation.qwMemorySize'] || 0) / MB);
        return /radeon|\bamd\b/i.test(name) && memoryMb >= SMALLEST_USEFUL_CARD_MB ? { name, memoryMb } : null;
    }).filter(Boolean);
};

const readLinuxAmd = async () => {
    const found = [];
    for (const card of await readdir('/sys/class/drm').catch(() => [])) {
        if (!/^card\d+$/.test(card)) continue;
        const device = `/sys/class/drm/${card}/device`;
        const vendor = (await readFile(`${device}/vendor`, 'utf8').catch(() => '')).trim();
        const bytes = Number((await readFile(`${device}/mem_info_vram_total`, 'utf8').catch(() => '0')).trim());
        if (vendor === '0x1002' && bytes >= SMALLEST_USEFUL_CARD_MB * MB) found.push({ name: 'AMD Radeon graphics card', memoryMb: Math.round(bytes / MB) });
    }
    return found;
};

const readGpus = async () => {
    try {
        const nvidia = parseNvidiaSmi(await runQuietly('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']));
        if (nvidia.length) return nvidia;
        const apple = appleGpus({ platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model?.trim(), memoryMb: Math.round(os.totalmem() / MB) });
        if (apple.length) return apple;
        if (process.platform === 'win32') return parseDisplayAdapters(await runQuietly('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DISPLAY_ADAPTERS]));
        if (process.platform === 'linux') return await readLinuxAmd();
        return [];
    } catch {
        return [];
    }
};

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
    const [gpus, disk] = await Promise.all([readGpus(), readDisk()]);
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

export const fitNotes = (catalogue, hardware) => {
    const gpuMemoryMb = Number(hardware?.gpuMemoryMb) || 0;
    const usableGpu = Math.max(0, gpuMemoryMb - GPU_HEADROOM_MB);
    const verdicts = catalogue.map((entry) => ({ entry, verdict: fitModel(entry, hardware).verdict }));
    const notes = [];
    if (gpuMemoryMb === 0) notes.push('No graphics card: models run on the processor, which is slower. More system memory lets larger models run.');
    const medium = catalogue.filter((entry) => entry.parameters >= 7 && entry.parameters <= 9).map(memoryNeededMb).sort((a, b) => a - b);
    if (medium.length > 1 && medium[0] + medium[1] <= usableGpu) notes.push('This graphics card has room for two 7 to 8B models at once, for example one for chat and one for code.');
    if (verdicts.some(({ entry, verdict }) => entry.moe && verdict === 'mixed')) notes.push('A large mixture-of-experts model runs here with help from system memory, so system memory matters as much as graphics memory for it.');
    if (verdicts.every(({ verdict }) => verdict === 'too_large')) notes.push('None of the listed models fits this device. A smaller model not on this list may still run, slowly.');
    return notes;
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

const PRIORITY = { interactive: 0, background: 1 };

export class GenerationQueue extends EventEmitter {
    constructor({ maxConcurrent = 1, perUserLimit = 5 } = {}) {
        super();
        this.setMaxListeners(200);
        this.maxConcurrent = maxConcurrent;
        this.perUserLimit = perUserLimit;
        this.waiting = [];
        this.running = new Set();
        this.lastServed = new Map();
        this.tick = 0;
        this.sequenceNumber = 0;
    }

    waitingFor(userId) {
        return this.waiting.filter((job) => job.userId === String(userId)).length;
    }

    order() {
        const served = new Map(this.lastServed);
        const pool = [...this.waiting];
        const ordered = [];
        let tick = this.tick;
        while (pool.length > 0) {
            pool.sort((a, b) =>
                PRIORITY[a.priority] - PRIORITY[b.priority]
                || (served.get(a.userId) || 0) - (served.get(b.userId) || 0)
                || a.sequence - b.sequence);
            const next = pool.shift();
            served.set(next.userId, ++tick);
            ordered.push(next);
        }
        return ordered;
    }

    ahead(job) {
        if (job.state !== 'waiting') return 0;
        return this.order().indexOf(job) + this.running.size;
    }

    add({ userId, priority = 'interactive', run }) {
        if (this.waitingFor(userId) >= this.perUserLimit) throw new OllamaError('QUEUE_FULL');
        const job = { userId: String(userId), priority, run, state: 'waiting', sequence: ++this.sequenceNumber };
        job.done = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        job.ahead = () => this.ahead(job);
        job.cancel = () => this.cancel(job);
        this.waiting.push(job);
        setImmediate(() => this.pump());
        return job;
    }

    cancel(job) {
        if (job.state !== 'waiting') return false;
        this.waiting = this.waiting.filter((other) => other !== job);
        job.state = 'cancelled';
        job.resolve(null);
        this.emit('moved');
        return true;
    }

    pump() {
        while (this.running.size < this.maxConcurrent && this.waiting.length > 0) {
            const job = this.order()[0];
            this.waiting = this.waiting.filter((other) => other !== job);
            this.lastServed.set(job.userId, ++this.tick);
            this.running.add(job);
            job.state = 'running';
            Promise.resolve()
                .then(() => job.run())
                .then(job.resolve, job.reject)
                .finally(() => {
                    job.state = 'finished';
                    this.running.delete(job);
                    this.emit('moved');
                    this.pump();
                });
        }
        this.emit('moved');
    }
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

const PLAIN_TEXT = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml', '.html', '.htm',
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.css', '.ini', '.toml'
]);
const NEVER_TEXT = new Set(['.doc', '.xls', '.xlsx', '.ppt', '.pptx']);

const looksLikeText = (buffer) => {
    const sample = buffer.subarray(0, 8000);
    if (sample.includes(0)) return false;
    const decoded = new TextDecoder('utf-8').decode(sample);
    return (decoded.match(/�/g) || []).length < 3;
};

export const extractText = async ({ buffer, name }) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new OllamaError('FILE_UNREADABLE');
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new OllamaError('FILE_TOO_LARGE');
    const extension = path.extname(String(name || '')).toLowerCase();

    let text;
    try {
        if (extension === '.pdf') {
            const { extractText: readPdf } = await import('unpdf');
            const result = await readPdf(new Uint8Array(buffer), { mergePages: true });
            text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
        } else if (extension === '.docx') {
            const mammoth = (await import('mammoth')).default;
            text = (await mammoth.extractRawText({ buffer })).value;
        } else if (PLAIN_TEXT.has(extension) || (!NEVER_TEXT.has(extension) && looksLikeText(buffer))) {
            text = buffer.toString('utf8').replace(/^﻿/, '');
        } else {
            throw new OllamaError('FILE_UNREADABLE');
        }
    } catch (error) {
        if (error instanceof OllamaError) throw error;
        throw new OllamaError('FILE_UNREADABLE', error.message);
    }

    text = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new OllamaError('FILE_UNREADABLE', 'no text found');
    return text;
};

const realFetch = (...args) => fetch(...args);
let filesFetch = realFetch;

export const setFilesFetch = (replacement) => {
    filesFetch = replacement || realFetch;
};

export const createFilesClient = ({ baseUrl, accessToken }) => {
    const root = `${String(baseUrl || '').replace(/\/+$/, '')}/api/v1/files`;
    const csrf = 'ai-base-server';
    const headers = { Cookie: `accessToken=${accessToken}; csrfToken=${csrf}`, 'X-CSRF-Token': csrf, Accept: 'application/json' };

    const call = async (url, options = {}, failure = 'FILE_NOT_FOUND') => {
        let response;
        try {
            response = await filesFetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20000) });
        } catch (error) {
            throw new OllamaError('FILES_DOWN', error.message);
        }
        if (response.status >= 500 || response.status === 429) throw new OllamaError('FILES_DOWN', `status ${response.status}`);
        if (!response.ok) throw new OllamaError(failure, `status ${response.status}`);
        return response;
    };
    const address = (filePath, part) => `${root}/${encodeURIComponent(filePath)}/${part}`;

    return {
        async browse(folder) {
            const response = await call(`${root}/directory/contents?filePath=${encodeURIComponent(folder)}`);
            const body = await response.json();
            const entries = (body.contents || []).map((entry) => ({
                name: entry.fileName,
                path: entry.filePath,
                type: entry.type === 'directory' ? 'folder' : 'file',
                size: entry.size || 0,
                updatedAt: entry.updatedAt || null
            }));
            return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1));
        },

        async text(filePath) {
            const name = filePath.split('/').pop();
            const extension = path.extname(name).toLowerCase();
            if (!['.pdf', '.docx'].includes(extension)) {
                const body = await (await call(address(filePath, 'content'))).json();
                if (body.fileType === 'text' && typeof body.content === 'string') {
                    const text = body.content.trim();
                    if (!text) throw new OllamaError('FILE_UNREADABLE', 'empty file');
                    return { name, text };
                }
            }
            const response = await call(address(filePath, 'download'), { headers: { Accept: '*/*' } });
            if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) throw new OllamaError('FILE_TOO_LARGE');
            const buffer = Buffer.from(await response.arrayBuffer());
            return { name, text: await extractText({ buffer, name }) };
        },

        async save(folder, name, content) {
            const filePath = `${folder.replace(/\/+$/, '')}/${name}`;
            const response = await call(root, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath, content, onConflict: 'rename' })
            }, 'FILE_NOT_SAVED');
            const body = await response.json();
            return { path: body.file?.filePath || filePath };
        }
    };
};

export const MAX_REMOTE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export const isPublicAddress = (address) => {
    const family = net.isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
        if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
        if (a === 203 && b === 0 && c === 113) return false;
        return true;
    }
    if (family === 6) {
        const text = address.toLowerCase();
        const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPublicAddress(mapped[1]);
        if (text === '::' || text === '::1') return false;
        if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(text)) return false;
        if (text.startsWith('::ffff:') || text.startsWith('64:ff9b:')) return false;
        return true;
    }
    return false;
};

const realRemote = {
    lookup: (host) => dns.lookup(host, { all: true }),
    request: (url, pinned) => new Promise((resolve, reject) => {
        const request = https.get(url, {
            timeout: 20000,
            headers: { 'User-Agent': 'Mollama/1.0 (local file viewer)', Accept: '*/*' },
            lookup: (hostname, options, callback) => (options?.all
                ? callback(null, [{ address: pinned.address, family: pinned.family }])
                : callback(null, pinned.address, pinned.family))
        }, (response) => resolve({ status: response.statusCode, headers: response.headers, stream: response }));
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    })
};
let remote = realRemote;
let remoteRetryMs = 1500;

export const setRemoteTransport = (replacement) => {
    remote = replacement ? { ...realRemote, ...replacement } : realRemote;
    remoteRetryMs = replacement ? 0 : 1500;
};

export const fetchRemote = async (address, redirects = 0, retried = false) => {
    let url;
    try {
        url = new URL(String(address));
    } catch {
        throw new OllamaError('REMOTE_BLOCKED');
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new OllamaError('REMOTE_BLOCKED');

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
        addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await remote.lookup(host);
    } catch (error) {
        throw new OllamaError('REMOTE_FAILED', error.message);
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new OllamaError('REMOTE_BLOCKED');
    }

    let response;
    try {
        response = await remote.request(url, addresses[0]);
    } catch (error) {
        throw new OllamaError('REMOTE_FAILED', error.message);
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        response.stream?.destroy?.();
        if (redirects >= MAX_REDIRECTS) throw new OllamaError('REMOTE_FAILED', 'too many redirects');
        return fetchRemote(new URL(response.headers.location, url).href, redirects + 1);
    }
    if ([429, 503].includes(response.status)) {
        response.stream?.destroy?.();
        if (retried) throw new OllamaError('REMOTE_BUSY', `status ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, remoteRetryMs));
        return fetchRemote(url.href, redirects, true);
    }
    if (response.status !== 200) {
        response.stream?.destroy?.();
        throw new OllamaError([404, 410].includes(response.status) ? 'REMOTE_NOT_FOUND' : 'REMOTE_FAILED', `status ${response.status}`);
    }
    if (Number(response.headers['content-length']) > MAX_REMOTE_BYTES) {
        response.stream?.destroy?.();
        throw new OllamaError('REMOTE_TOO_LARGE');
    }
    return { stream: response.stream, contentType: response.headers['content-type'] || null, size: Number(response.headers['content-length']) || null };
};

const SEARCH_SMALL_WORDS = new Set(['an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'from', 'by', 'at', 'as', 'is']);
let searchFetch = realFetch;

export const setSearchFetch = (replacement) => {
    searchFetch = replacement || realFetch;
};

const searchKey = () => String(process.env.TAVILY_API_KEY || '').trim();
export const searchReady = () => Boolean(searchKey());

const askSearch = async (url, options) => {
    let response;
    try {
        response = await searchFetch(url, { ...options, signal: AbortSignal.timeout(20000) });
    } catch (error) {
        throw new OllamaError('SEARCH_DOWN', error.message);
    }
    if ([429, 432, 433].includes(response.status)) throw new OllamaError('SEARCH_LIMITED', `status ${response.status}`);
    if (!response.ok) throw new OllamaError('SEARCH_REFUSED', `status ${response.status}`);
    try {
        return await response.json();
    } catch {
        throw new OllamaError('SEARCH_REFUSED', 'the answer was not JSON');
    }
};

export const searchWeb = async (query) => {
    const body = await askSearch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${searchKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' })
    });
    const wanted = [...new Set((String(query).toLowerCase().replace(/\b(?:site|filetype):\S+/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) || []).filter((word) => !SEARCH_SMALL_WORDS.has(word)))];
    const needed = Math.min(2, wanted.length);
    const results = (Array.isArray(body?.results) ? body.results : []).filter((result) => {
        const text = `${result.title ?? ''} ${result.content ?? ''} ${result.url ?? ''}`.toLowerCase();
        return wanted.filter((word) => text.includes(word)).length >= needed;
    });
    return results.slice(0, 5).map((result) => ({
        title: String(result.title ?? ''),
        url: String(result.url ?? ''),
        content: String(result.content ?? '')
    }));
};

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
});

export const readPage = async (address) => {
    const { stream, contentType } = await fetchRemote(address);
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (type && !/^text\/|json|xml/.test(type)) {
        stream.destroy?.();
        return { title: '', content: `This address is a file of type ${type}, not a page of text.`, links: [], media: [], embedded: [], file: type };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_PAGE_BYTES) break;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!type.includes('html') && !/^\s*<(?:!doctype|html)/i.test(raw)) return { title: '', content: raw, links: [], media: [], embedded: [], file: type || null };

    const title = decodeEntities((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
    const absolute = (pattern) => [...new Set([...raw.matchAll(pattern)].map((match) => {
        try {
            return new URL(decodeEntities(match[1]), address).href;
        } catch {
            return null;
        }
    }).filter((link) => link && link.startsWith('https://')))];
    const links = absolute(/<a\s[^>]*?href\s*=\s*["']([^"'#]+)["']/gi);
    const media = [...new Set([
        ...absolute(/<meta\s[^>]*?(?:property|name)\s*=\s*["']og:(?:image|video|audio)[^"']*["'][^>]*?content\s*=\s*["']([^"']+)["']/gi),
        ...absolute(/<(?:img|source|video|audio|embed)\s[^>]*?(?:data-src|src)\s*=\s*["']([^"'#]+)["']/gi)
    ])];
    const content = decodeEntities(raw
        .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(?:p|div|li|h\d|tr|section|article|pre|blockquote)>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[ \t\r]+/g, ' ')
        .replace(/ ?\n[ \n]*/g, '\n')
        .trim();
    const embedded = [...new Set(raw.replace(/\\\//g, '/').match(/https:\/\/[^\s"'<>\\)]+/g) || [])].slice(0, 2000);
    return { title, content, links, media, embedded, file: null };
};
