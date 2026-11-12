import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import logger from '../utils/app.logger.js';
import { asyncHandler } from '../middleware/app.middleware.js';
import { hasRight, RIGHTS } from '../config/rights.js';
import { SERVICE, Device, Setting, PersonalModel, Download } from '../models/ai.model.js';
import {
    OllamaError, mapOllamaError, createOllamaClient, detectHardware, readDisk, rankCatalogue, fitModel
} from '../middleware/ai.middleware.js';

const MB = 1024 * 1024;
const catalogue = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'ai.catalogue.json'), 'utf8'));
const catalogueByTag = new Map(catalogue.map((entry) => [entry.tag, entry]));

const canManage = (req) => hasRight(req.user.roles, RIGHTS.MANAGE_MODELS);

const sendOllamaError = (res, error) => {
    if (!(error instanceof OllamaError)) throw error;
    const body = { success: false, ...error.toJSON() };
    if (error.neededMb) {
        body.neededMb = error.neededMb;
        body.freeMb = error.freeMb;
        body.message = `This model needs about ${Math.ceil(error.neededMb / 1024)} GB and this device has ${Math.floor(error.freeMb / 1024)} GB free.`;
    }
    return res.status(error.status).json(body);
};

const getSettings = async () => {
    const existing = await Setting.findOne({ service: SERVICE });
    if (existing) return existing;
    try {
        return await Setting.create({});
    } catch (error) {
        if (error?.code === 11000) return Setting.findOne({ service: SERVICE });
        throw error;
    }
};

const resolveOllamaHost = async () => {
    const settings = await getSettings();
    return settings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL;
};

const getOllama = async () => createOllamaClient(await resolveOllamaHost());

const SAVE_EVERY_MS = 2000;
const EMIT_EVERY_MS = 400;
const OPEN_STATES = ['queued', 'downloading', 'paused'];
const FINAL_STATES = ['completed', 'failed', 'cancelled'];

const within = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('database did not answer in time')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const health = {
    databaseReady: () => mongoose.connection.readyState === 1
};

export const requireDatabase = (req, res, next) => {
    if (health.databaseReady()) return next();
    res.status(503).json({
        success: false,
        code: 'DATABASE_DOWN',
        message: 'AI Base cannot reach its database.',
        action: 'Check the internet connection. A download that is running carries on by itself.'
    });
};

class DownloadManager extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.diskProbe = readDisk;
        this.active = null;
        this.live = new Map();
        this.stallWarnMs = 20000;
        this.stallFailMs = 180000;
        this.retryMs = 5000;
        this.saveWaitMs = 3000;
    }

    setDiskProbe(probe) {
        this.diskProbe = probe || readDisk;
    }

    async freeMb() {
        try {
            return (await this.diskProbe()).diskFreeMb;
        } catch {
            return null;
        }
    }

    present(doc) {
        const live = this.live.get(doc.id) || {};
        const status = live.status ?? doc.status;
        const errorCode = live.errorCode !== undefined ? live.errorCode : doc.errorCode;
        const completedBytes = live.completedBytes ?? doc.completedBytes;
        const totalBytes = live.totalBytes ?? doc.totalBytes;
        const speedBps = status === 'downloading' ? live.speedBps || 0 : 0;

        return {
            id: doc.id,
            model: doc.model,
            status,
            stalled: status === 'downloading' && Boolean(live.stalled),
            completedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.min(100, Math.floor((completedBytes / totalBytes) * 100)) : 0,
            speedBps,
            etaSeconds: speedBps > 0 && totalBytes > completedBytes ? Math.ceil((totalBytes - completedBytes) / speedBps) : null,
            error: errorCode ? new OllamaError(errorCode).toJSON() : null,
            requestedBy: doc.requestedBy,
            createdAt: doc.createdAt,
            finishedAt: live.finishedAt !== undefined ? live.finishedAt : doc.finishedAt
        };
    }

    announce(doc) {
        this.emit('progress', this.present(doc));
    }

    async list() {
        const docs = await Download.find({ service: SERVICE }).sort({ createdAt: -1 }).limit(30);
        return docs.map((doc) => this.present(doc));
    }

    save(doc, fields, { final = false, attempt = 0 } = {}) {
        return within(Download.updateOne({ _id: doc._id }, fields), this.saveWaitMs)
            .then(() => {
                if (final) this.live.delete(doc.id);
            })
            .catch(() => {
                if (!final || attempt >= 240) return;
                setTimeout(() => this.save(doc, fields, { final, attempt: attempt + 1 }), this.retryMs).unref?.();
            });
    }

    async clearFailed(model, keepId) {
        try {
            const stale = await Download.find({ service: SERVICE, model, status: 'failed', _id: { $ne: keepId } });
            for (const doc of stale) {
                this.live.delete(doc.id);
                Object.assign(doc, { status: 'cancelled', finishedAt: new Date() });
                await doc.save();
                this.announce(doc);
            }
        } catch (error) {
            logger.warn('[Downloads] Old failed downloads could not be cleared', { model, message: error.message });
        }
    }

    async enqueue({ model, userId, sizeHintMb = null }) {
        if (sizeHintMb) {
            const freeMb = await this.freeMb();
            if (freeMb !== null && sizeHintMb > freeMb) {
                const error = new OllamaError('DISK_FULL');
                error.neededMb = sizeHintMb;
                error.freeMb = freeMb;
                throw error;
            }
        }

        const open = await Download.find({ service: SERVICE, model, status: { $in: OPEN_STATES } });
        let doc = open.find((candidate) => !FINAL_STATES.includes(this.live.get(candidate.id)?.status)) || null;

        if (doc && this.active?.id !== doc.id && (this.live.get(doc.id)?.status ?? doc.status) === 'paused') {
            this.live.delete(doc.id);
            doc.status = 'queued';
            doc.errorCode = null;
            await doc.save();
        }
        if (!doc) {
            doc = await Download.findOne({ service: SERVICE, model, status: 'failed' }).sort({ createdAt: -1 });
            if (doc) {
                this.live.delete(doc.id);
                Object.assign(doc, { status: 'queued', errorCode: null, finishedAt: null, requestedBy: userId });
                await doc.save();
            }
        }
        if (!doc) doc = await Download.create({ model, requestedBy: userId });
        await this.clearFailed(model, doc.id);

        this.announce(doc);
        this.next();
        return this.present(doc);
    }

    async next() {
        if (this.active) return;
        let doc;
        try {
            doc = await Download.findOne({ service: SERVICE, status: 'queued' }).sort({ createdAt: 1 });
        } catch {
            setTimeout(() => this.next(), this.retryMs).unref?.();
            return;
        }
        if (!doc || this.active) return;
        this.active = { id: doc.id, stream: null, stopAs: null, stalledOut: false };
        this.run(doc).catch((error) => {
            logger.error('[Downloads] Unexpected failure', { error: error.message });
            if (this.active?.id === doc.id) this.active = null;
            this.next();
        });
    }

    async run(doc) {
        const job = this.active;
        const layers = new Map();
        const state = {
            doc,
            status: 'downloading',
            errorCode: null,
            finishedAt: null,
            completedBytes: doc.completedBytes,
            totalBytes: doc.totalBytes,
            speedBps: 0,
            stalled: false
        };
        this.live.set(doc.id, state);

        let lastSave = 0;
        let lastEmit = 0;
        let lastBytes = state.completedBytes;
        let lastTick = Date.now();
        let lastAdvance = Date.now();
        let advanceMark = state.completedBytes;

        doc.status = 'downloading';
        doc.startedAt = doc.startedAt || new Date();
        doc.errorCode = null;
        await this.save(doc, { status: 'downloading', startedAt: doc.startedAt, errorCode: null });
        this.announce(doc);

        const watchdog = setInterval(() => {
            const waitingForBytes = state.totalBytes === 0 || state.completedBytes < state.totalBytes;
            const quietFor = Date.now() - lastAdvance;
            if (!waitingForBytes) return;
            if (quietFor >= this.stallFailMs) {
                job.stalledOut = true;
                job.stream?.abort?.();
            } else if (quietFor >= this.stallWarnMs && !state.stalled) {
                state.stalled = true;
                state.speedBps = 0;
                this.announce(doc);
            }
        }, Math.max(50, Math.min(2000, Math.floor(this.stallWarnMs / 4))));
        watchdog.unref?.();

        const freeAtStartMb = await this.freeMb();
        let hardware = null;
        try {
            hardware = effectiveHardware(await getLocalDevice());
        } catch {
            hardware = null;
        }
        let outcome = 'completed';
        let errorCode = null;

        try {
            const ollama = await getOllama();
            const stream = await ollama.pull(doc.model);
            job.stream = stream;
            if (job.stopAs || job.stalledOut) stream.abort?.();

            for await (const part of stream) {
                if (job.stopAs || job.stalledOut) break;
                if (part.error) throw mapOllamaError({ error: part.error });

                if (part.digest && part.total) {
                    layers.set(part.digest, { total: part.total, completed: part.completed || 0 });
                    let total = 0;
                    let completed = 0;
                    for (const layer of layers.values()) {
                        total += layer.total;
                        completed += layer.completed;
                    }
                    state.totalBytes = Math.max(state.totalBytes, total);
                    state.completedBytes = completed;

                    if (hardware && !fitModel({ sizeMb: state.totalBytes / MB, parameters: 0, moe: false }, hardware).fits) {
                        throw new OllamaError('MODEL_TOO_LARGE');
                    }
                    if (freeAtStartMb !== null && (state.totalBytes - completed) / MB > freeAtStartMb) {
                        throw new OllamaError('DISK_FULL');
                    }
                }

                const now = Date.now();
                if (state.completedBytes !== advanceMark) {
                    advanceMark = state.completedBytes;
                    lastAdvance = now;
                    if (state.stalled) {
                        state.stalled = false;
                        this.announce(doc);
                    }
                }
                if (now - lastTick >= 1000) {
                    state.speedBps = Math.max(0, ((state.completedBytes - lastBytes) * 1000) / (now - lastTick));
                    lastBytes = state.completedBytes;
                    lastTick = now;
                }
                if (now - lastEmit >= EMIT_EVERY_MS) {
                    lastEmit = now;
                    this.announce(doc);
                }
                if (now - lastSave >= SAVE_EVERY_MS) {
                    lastSave = now;
                    this.save(doc, { completedBytes: state.completedBytes, totalBytes: state.totalBytes });
                }
            }
            if (job.stalledOut && !job.stopAs) throw new OllamaError('DOWNLOAD_INTERRUPTED');
            if (job.stopAs) outcome = job.stopAs;
        } catch (error) {
            if (job.stopAs) {
                outcome = job.stopAs;
            } else {
                outcome = 'failed';
                errorCode = job.stalledOut ? 'DOWNLOAD_INTERRUPTED' : mapOllamaError(error).code;
                if (errorCode === 'UNKNOWN') errorCode = 'DOWNLOAD_INTERRUPTED';
                if (errorCode === 'MODEL_MISSING') errorCode = 'MODEL_NOT_FOUND';
                logger.warn('[Downloads] Download failed', { model: doc.model, code: errorCode, stalled: job.stalledOut });
            }
        } finally {
            clearInterval(watchdog);
        }

        if (outcome === 'completed' && state.totalBytes > 0) state.completedBytes = state.totalBytes;

        const result = {
            status: outcome,
            completedBytes: state.completedBytes,
            totalBytes: state.totalBytes,
            errorCode,
            finishedAt: FINAL_STATES.includes(outcome) ? new Date() : null
        };
        Object.assign(doc, result);
        Object.assign(state, { status: outcome, errorCode, finishedAt: result.finishedAt, stalled: false, speedBps: 0 });

        await this.save(doc, result, { final: true });

        this.active = null;
        this.announce(doc);
        if (outcome === 'completed') await this.clearFailed(doc.model, doc.id);
        this.emit('settled', this.present(doc));
        this.next();
    }

    async stop(id, action) {
        const outcome = action === 'pause' ? 'paused' : 'cancelled';

        if (this.active?.id === String(id)) {
            const { doc } = this.live.get(String(id));
            this.active.stopAs = outcome;
            this.active.stream?.abort?.();
            await this.settled(String(id));
            return this.present(doc);
        }

        const doc = await Download.findOne({ _id: id, service: SERVICE });
        if (!doc) return null;
        const status = this.live.get(doc.id)?.status ?? doc.status;
        const dismissing = status === 'failed' && outcome === 'cancelled';
        if (!OPEN_STATES.includes(status) && !dismissing) return this.present(doc);
        this.live.delete(doc.id);

        doc.status = outcome;
        doc.finishedAt = outcome === 'cancelled' ? new Date() : null;
        await doc.save();
        this.announce(doc);
        return this.present(doc);
    }

    settled(id, timeoutMs = 10000) {
        return new Promise((resolve) => {
            if (this.active?.id !== id) return resolve();
            const done = () => {
                clearTimeout(timer);
                this.off('settled', onSettled);
                resolve();
            };
            const onSettled = (job) => {
                if (job.id === id) done();
            };
            const timer = setTimeout(done, timeoutMs);
            this.on('settled', onSettled);
        });
    }

    async recover() {
        const interrupted = await Download.updateMany(
            { service: SERVICE, status: 'downloading' },
            { status: 'queued' }
        );
        if (interrupted.modifiedCount > 0) {
            logger.info(`[Downloads] Resuming ${interrupted.modifiedCount} interrupted download(s)`);
        }
        this.next();
    }

    async idle(timeoutMs = 15000) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const open = await Download.countDocuments({ service: SERVICE, status: { $in: ['queued', 'downloading'] } });
            if (!this.active && open === 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
    }
}

export const downloads = new DownloadManager();


const presentSettings = (settings) => ({
    ollamaBaseUrl: settings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL,
    ollamaBaseUrlIsDefault: !settings.ollamaBaseUrl,
    defaultModel: settings.defaultModel,
    maxConcurrentGenerations: settings.maxConcurrentGenerations,
    keepAliveMinutes: settings.keepAliveMinutes,
    updatedAt: settings.updatedAt
});

const getLocalDevice = async ({ redetect = false } = {}) => {
    const hostname = os.hostname();
    let device = await Device.findOne({ service: SERVICE, kind: 'local', hostname });
    const detected = !device || !device.hardware || redetect ? await detectHardware() : null;
    if (!device) {
        try {
            device = await Device.create({ name: hostname, kind: 'local', hostname, hardware: detected });
        } catch (error) {
            if (error?.code !== 11000) throw error;
            device = await Device.findOne({ service: SERVICE, kind: 'local', hostname });
        }
    } else if (detected) {
        device.hardware = detected;
    }
    device.lastSeenAt = new Date();
    await device.save();
    return device;
};

const effectiveHardware = (device) => {
    const detected = device.hardware?.toObject?.() || device.hardware || {};
    const overrides = device.overrides || {};
    const gpuName = overrides.gpuName || detected.gpus?.[0]?.name || null;
    const gpuMemoryMb = overrides.gpuMemoryMb ?? detected.gpuMemoryMb ?? 0;

    return {
        memoryMb: overrides.memoryMb ?? detected.memoryMb ?? null,
        gpuName,
        gpuMemoryMb,
        hasGpu: gpuMemoryMb > 0,
        cpu: detected.cpu || null,
        cpuThreads: detected.cpuThreads || null,
        diskFreeMb: detected.diskFreeMb ?? null,
        diskTotalMb: detected.diskTotalMb ?? null,
        platform: detected.platform || null
    };
};

const readOllama = async (host) => {
    const client = createOllamaClient(host);
    const status = await client.status();
    if (!status.available) return { ...status, modelCount: 0 };
    try {
        const { models } = await client.list();
        return { ...status, modelCount: models.length };
    } catch {
        return { ...status, modelCount: 0 };
    }
};

const presentDevice = (device, ollama) => ({
    id: device.id,
    name: device.name,
    kind: device.kind,
    service: device.service,
    online: true,
    lastSeenAt: device.lastSeenAt,
    hardware: effectiveHardware(device),
    detected: device.hardware,
    overrides: device.overrides,
    edited: Object.values(device.overrides?.toObject?.() || device.overrides || {}).some((value) => value !== null && value !== ''),
    ollama
});


export const listDevices = asyncHandler(async (req, res) => {
    const device = await getLocalDevice();
    const ollama = await readOllama(await resolveOllamaHost());

    res.status(200).json({
        success: true,
        devices: [presentDevice(device, ollama)],
        permissions: { manage: canManage(req) }
    });
});

export const getDevice = asyncHandler(async (req, res) => {
    const local = await getLocalDevice();
    if (local.id !== req.params.id) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    const ollama = await readOllama(await resolveOllamaHost());
    res.status(200).json({ success: true, device: presentDevice(local, ollama), permissions: { manage: canManage(req) } });
});

export const updateDevice = asyncHandler(async (req, res) => {
    const device = await getLocalDevice();
    if (device.id !== req.params.id) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }

    const { name, overrides } = req.body;
    if (name) device.name = name;
    if (overrides) {
        for (const key of ['memoryMb', 'gpuName', 'gpuMemoryMb']) {
            if (key in overrides) device.overrides[key] = overrides[key] === '' ? null : overrides[key];
        }
    }
    await device.save();
    logger.info('[Device] Device updated', { deviceId: device.id, userId: req.user.id });

    const ollama = await readOllama(await resolveOllamaHost());
    res.status(200).json({ success: true, device: presentDevice(device, ollama) });
});

export const detectDevice = asyncHandler(async (req, res) => {
    const current = await getLocalDevice();
    if (current.id !== req.params.id) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    const device = await getLocalDevice({ redetect: true });
    const ollama = await readOllama(await resolveOllamaHost());
    res.status(200).json({ success: true, device: presentDevice(device, ollama) });
});

export const readSettings = asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.status(200).json({ success: true, settings: presentSettings(settings), permissions: { manage: canManage(req) } });
});

export const updateSettings = asyncHandler(async (req, res) => {
    const settings = await getSettings();
    for (const key of ['ollamaBaseUrl', 'defaultModel']) {
        if (key in req.body) settings[key] = req.body[key] || null;
    }
    for (const key of ['maxConcurrentGenerations', 'keepAliveMinutes']) {
        if (key in req.body) settings[key] = req.body[key];
    }
    settings.updatedBy = req.user.id;
    await settings.save();
    logger.info('[Settings] Settings updated', { userId: req.user.id, fields: Object.keys(req.body) });

    res.status(200).json({ success: true, settings: presentSettings(settings) });
});

export const testConnection = asyncHandler(async (req, res) => {
    const status = await createOllamaClient(req.body.ollamaBaseUrl).status();
    if (!status.available) {
        return sendOllamaError(res, new OllamaError('OLLAMA_DOWN'));
    }
    res.status(200).json({ success: true, ollama: status });
});

export const getSetupStatus = asyncHandler(async (req, res) => {
    const host = await resolveOllamaHost();
    const ollama = await readOllama(host);
    const device = await getLocalDevice();

    res.status(200).json({
        success: true,
        ollama: ollama.available
            ? ollama
            : { ...ollama, ...new OllamaError('OLLAMA_DOWN').toJSON() },
        device: { id: device.id, name: device.name, detected: Boolean(device.hardware) },
        steps: {
            ollama: ollama.available,
            device: Boolean(device.hardware),
            model: ollama.modelCount > 0
        }
    });
});

const contextLength = (shown) => {
    const info = shown?.model_info || {};
    const key = Object.keys(info).find((name) => name.endsWith('.context_length'));
    return key ? info[key] : null;
};

const describeInstalled = async (ollama, model, personalByName) => {
    let shown = null;
    try {
        shown = await ollama.show(model.name);
    } catch {
        shown = null;
    }
    const known = catalogueByTag.get(model.name);
    const personal = personalByName.get(model.name) || personalByName.get(model.name.replace(/:latest$/, ''));

    return {
        name: model.name,
        displayName: personal?.displayName || known?.name || model.name,
        description: known?.description || null,
        sizeBytes: model.size || 0,
        family: model.details?.family || null,
        parameterSize: model.details?.parameter_size || null,
        quantization: model.details?.quantization_level || null,
        contextLength: contextLength(shown),
        capabilities: shown?.capabilities || known?.capabilities || [],
        modifiedAt: model.modified_at || null,
        personal: Boolean(personal),
        basedOn: personal?.from || null
    };
};

export const listModels = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    const status = await ollama.status();
    const disk = await readDisk();

    if (!status.available) {
        return res.status(200).json({
            success: true,
            ollamaAvailable: false,
            ollamaVersion: null,
            models: [],
            disk: { usedByModelsMb: 0, freeMb: disk.diskFreeMb, totalMb: disk.diskTotalMb },
            permissions: { manage: canManage(req) }
        });
    }

    const { models: installed } = await ollama.list();
    const personal = await PersonalModel.find({ service: SERVICE });
    const personalByName = new Map(personal.map((entry) => [entry.name, entry]));

    const models = await Promise.all(installed.map((model) => describeInstalled(ollama, model, personalByName)));
    for (const model of models) {
        model.usedBy = personal.filter((entry) => entry.from === model.name).map((entry) => entry.displayName);
    }
    models.sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.status(200).json({
        success: true,
        ollamaAvailable: true,
        ollamaVersion: status.version,
        models,
        disk: {
            usedByModelsMb: Math.round(models.reduce((sum, model) => sum + model.sizeBytes, 0) / MB),
            freeMb: disk.diskFreeMb,
            totalMb: disk.diskTotalMb
        },
        permissions: { manage: canManage(req) }
    });
});

export const listRunning = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        const { models } = await ollama.running();
        res.status(200).json({
            success: true,
            models: models.map((model) => {
                const size = model.size || 0;
                const onGpu = model.size_vram || 0;
                const gpuPercent = size > 0 ? Math.min(100, Math.round((onGpu / size) * 100)) : 0;
                return {
                    name: model.name,
                    displayName: catalogueByTag.get(model.name)?.name || model.name,
                    sizeBytes: size,
                    gpuBytes: onGpu,
                    gpuPercent,
                    healthy: gpuPercent >= 100,
                    expiresAt: model.expires_at || null
                };
            }),
            permissions: { manage: canManage(req) }
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const showModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        const shown = await ollama.show(req.body.name);
        res.status(200).json({
            success: true,
            model: {
                name: req.body.name,
                definition: shown.modelfile || '',
                parameters: shown.parameters || '',
                template: shown.template || '',
                system: shown.system || '',
                capabilities: shown.capabilities || [],
                contextLength: contextLength(shown),
                details: shown.details || {}
            }
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const deleteModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        await ollama.remove(req.body.name);
    } catch (error) {
        return sendOllamaError(res, error);
    }
    await PersonalModel.deleteOne({ service: SERVICE, name: req.body.name.replace(/:latest$/, '') });
    logger.info('[Models] Model deleted', { model: req.body.name, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Model removed from this device.' });
});

export const unloadModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        await ollama.unload(req.body.name);
    } catch (error) {
        return sendOllamaError(res, error);
    }
    logger.info('[Models] Model unloaded', { model: req.body.name, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Model removed from memory.' });
});

export const createModel = asyncHandler(async (req, res) => {
    const { name, displayName, from, system = '', template = '', parameters = {} } = req.body;
    const ollama = await getOllama();

    try {
        const { models: installed } = await ollama.list();
        const names = new Set(installed.flatMap((model) => [model.name, model.name.replace(/:latest$/, '')]));
        if (names.has(name)) {
            return res.status(409).json({ success: false, message: 'A model with this name already exists. Choose another name.' });
        }
        if (!names.has(from)) {
            return sendOllamaError(res, new OllamaError('MODEL_MISSING'));
        }

        const request = { model: name, from, stream: false };
        if (system) request.system = system;
        if (template) request.template = template;
        if (Object.keys(parameters).length > 0) request.parameters = parameters;
        await ollama.create(request);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    const record = await PersonalModel.findOneAndUpdate(
        { service: SERVICE, name },
        { displayName, from, system, parameters, createdBy: req.user.id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    logger.info('[Models] Personal model created', { model: name, from, userId: req.user.id });
    res.status(201).json({ success: true, model: { name: record.name, displayName: record.displayName, basedOn: record.from } });
});

export const startDownload = asyncHandler(async (req, res) => {
    const known = catalogueByTag.get(req.body.name);
    try {
        if (known) {
            const hardware = effectiveHardware(await getLocalDevice());
            const fit = fitModel(known, hardware);
            if (!fit.fits) {
                const error = new OllamaError('MODEL_TOO_LARGE');
                error.detail = `${known.name} needs about ${Math.ceil(fit.memoryNeededMb / 1024)} GB of memory. This device has ${Math.floor((hardware.gpuMemoryMb || 0) / 1024)} GB of graphics memory and ${Math.floor((hardware.memoryMb || 0) / 1024)} GB of system memory.`;
                return res.status(error.status).json({ success: false, ...error.toJSON(), message: error.detail });
            }
        }
        const job = await downloads.enqueue({
            model: req.body.name,
            userId: req.user.id,
            sizeHintMb: known?.sizeMb || null
        });
        res.status(202).json({ success: true, download: job });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const listDownloads = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, downloads: await downloads.list(), permissions: { manage: canManage(req) } });
});

export const changeDownload = asyncHandler(async (req, res) => {
    const job = await downloads.stop(req.body.id, req.body.action);
    if (!job) return res.status(404).json({ success: false, message: 'Download not found' });
    res.status(200).json({ success: true, download: job });
});

export const streamDownloads = asyncHandler(async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', await downloads.list());

    const onProgress = (job) => send('progress', job);
    downloads.on('progress', onProgress);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        downloads.off('progress', onProgress);
    });
});

const installedNames = async () => {
    try {
        const ollama = await getOllama();
        const { models } = await ollama.list();
        return new Set(models.map((model) => model.name));
    } catch {
        return new Set();
    }
};

export const getPublicCatalogue = asyncHandler(async (req, res) => {
    const { memoryMb, gpuMemoryMb } = req.query;
    const hasSpecs = memoryMb !== undefined;
    const hardware = { memoryMb: Number(memoryMb) || 0, gpuMemoryMb: Number(gpuMemoryMb) || 0 };

    res.status(200).json({
        success: true,
        hardware: hasSpecs ? hardware : null,
        models: hasSpecs ? rankCatalogue(catalogue, hardware) : catalogue.map((entry) => ({ ...entry, fit: null, pick: null }))
    });
});

export const getDeviceCatalogue = asyncHandler(async (req, res) => {
    const device = await getLocalDevice();
    if (device.id !== req.params.id) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    const hardware = effectiveHardware(device);
    const installed = await installedNames();
    const disk = await readDisk();

    res.status(200).json({
        success: true,
        hardware,
        freeDiskMb: disk.diskFreeMb,
        models: rankCatalogue(catalogue, hardware).map((entry) => ({
            ...entry,
            installed: installed.has(entry.tag),
            fitsDisk: disk.diskFreeMb === null ? true : entry.sizeMb <= disk.diskFreeMb
        })),
        permissions: { manage: canManage(req) }
    });
});
