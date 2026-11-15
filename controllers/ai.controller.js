import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import mongoose from 'mongoose';
import logger from '../utils/app.logger.js';
import { asyncHandler, getNotificationService } from '../middleware/app.middleware.js';
import { hasRight, RIGHTS } from '../config/rights.js';
import { SERVICE, Device, Setting, PersonalModel, Download, Chat, Prompt, Guide, GUIDE_STEPS, MANAGER_GUIDE_STEPS, chatSchemas } from '../models/ai.model.js';
import {
    OllamaError, mapOllamaError, createOllamaClient, detectHardware, appleGpus, readDisk, rankCatalogue, fitModel, fitNotes, GPU_HEADROOM_MB, RAM_RESERVE_MB,
    GenerationQueue, estimateTokens, extractText, createFilesClient, MAX_ATTACHMENT_BYTES, fetchRemote, MAX_REMOTE_BYTES,
    searchReady, searchWeb, readPage, deviceGateway
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

// Which device a request works on: the server's own computer, one of the person's linked computers, or none.
const deviceScope = new AsyncLocalStorage();
const LOCAL_TARGET = { kind: 'local', id: null };
const NO_TARGET = { kind: 'none', id: null };
const DEVICE_HOST = 'http://device.mollama';
// A hosted server has no Ollama of its own, so in production its computer is not a device unless asked for.
const localEnabled = () => (process.env.LOCAL_DEVICE ? process.env.LOCAL_DEVICE === 'true' : process.env.NODE_ENV !== 'production');
const currentTarget = () => deviceScope.getStore() || (localEnabled() ? LOCAL_TARGET : NO_TARGET);
const targetOf = (device) => (device.kind === 'companion' ? { kind: 'companion', id: String(device.id) } : LOCAL_TARGET);

const getOllama = async () => {
    const target = currentTarget();
    if (target.kind === 'companion') return createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(target.id));
    if (target.kind === 'none') return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('NO_DEVICE')));
    return createOllamaClient(await resolveOllamaHost());
};

const diskNow = async () => {
    const target = currentTarget();
    if (target.kind === 'local') return readDisk();
    const unknown = { diskFreeMb: null, diskTotalMb: null };
    if (target.kind === 'none') return unknown;
    return deviceGateway.ask(target.id, 'disk').then((disk) => ({ ...unknown, ...disk }), () => unknown);
};

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
        message: 'Mollama cannot reach its database.',
        action: 'Check the internet connection. A download that is running carries on by itself.'
    });
};

class DownloadManager extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.diskProbe = diskNow;
        this.active = null;
        this.live = new Map();
        this.stallWarnMs = 20000;
        this.stallFailMs = 180000;
        this.retryMs = 5000;
        this.saveWaitMs = 3000;
    }

    setDiskProbe(probe) {
        this.diskProbe = probe || diskNow;
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
                Object.assign(doc, { status: 'queued', errorCode: null, finishedAt: null, requestedBy: userId, device: currentTarget().id });
                await doc.save();
            }
        }
        if (!doc) doc = await Download.create({ model, requestedBy: userId, device: currentTarget().id });
        await this.clearFailed(model, doc.id);

        this.announce(doc);
        getNotificationService().broadcast('activity:changed');
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
        const target = doc.device ? { kind: 'companion', id: String(doc.device) } : localEnabled() ? LOCAL_TARGET : NO_TARGET;
        deviceScope.run(target, () => this.run(doc)).catch((error) => {
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
        getNotificationService().broadcast('activity:changed');

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
            hardware = effectiveHardware(await getCurrentDevice());
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

        this.announce(doc);
        if (outcome === 'completed') await this.clearFailed(doc.model, doc.id);
        this.active = null;
        if (outcome === 'completed') {
            getNotificationService().broadcast('download:finished', { level: 'success', message: `${doc.model} has finished downloading.`, model: doc.model, id: doc.id }, [doc.requestedBy]);
        } else if (outcome === 'failed') {
            getNotificationService().notify(doc.requestedBy, 'download:failed', { level: 'error', message: `${doc.model} could not be downloaded. ${new OllamaError(errorCode).message}`, model: doc.model, id: doc.id });
        }
        getNotificationService().broadcast('activity:changed');
        this.emit('settled', this.present(doc));
        this.next();
    }

    async stop(id, action) {
        const outcome = action === 'pause' ? 'paused' : 'cancelled';

        if (this.active?.id === String(id)) {
            const state = this.live.get(String(id));
            const running = !state || state.status === 'downloading';
            if (running) {
                this.active.stopAs = outcome;
                this.active.stream?.abort?.();
            }
            await this.settled(String(id));
            if (running && state) return this.present(state.doc);
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
        getNotificationService().broadcast('activity:changed');
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

const getCurrentDevice = async () => {
    const target = currentTarget();
    if (target.kind === 'companion') return Device.findOne({ _id: target.id, service: SERVICE });
    if (target.kind === 'none') return null;
    return getLocalDevice();
};

const effectiveHardware = (device) => {
    const detected = device?.hardware?.toObject?.() || device?.hardware || {};
    const overrides = device?.overrides || {};
    // A Mac read by an older desktop app has no graphics recorded. An Apple chip always has them, so they are worked out here.
    const appleChip = /^Apple /.test(detected.cpu || '') ? 'arm64' : '';
    const [apple] = detected.gpus?.length ? [] : appleGpus({ platform: detected.platform, arch: appleChip, cpu: detected.cpu, memoryMb: detected.memoryMb || 0 });
    const gpuName = overrides.gpuName || detected.gpus?.[0]?.name || apple?.name || null;
    const gpuMemoryMb = overrides.gpuMemoryMb ?? (detected.gpuMemoryMb || apple?.memoryMb || 0);

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

const readOllama = async (client) => {
    const status = await client.status();
    if (!status.available) return { ...status, modelCount: 0 };
    try {
        const { models } = await client.list();
        return { ...status, modelCount: models.length };
    } catch {
        return { ...status, modelCount: 0 };
    }
};

const UNREACHED = { available: false, version: null, modelCount: 0 };
const isOnline = (device) => device.kind === 'local' || deviceGateway.isOnline(device.id);
const ollamaOf = (device) => (isOnline(device) ? deviceScope.run(targetOf(device), async () => readOllama(await getOllama())) : UNREACHED);
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

const ownDevices = (userId) => Device.find({ service: SERVICE, kind: 'companion', registeredBy: userId }).sort({ lastSeenAt: -1 });

const allowedDevice = async (req, id) => {
    const device = await Device.findOne({ _id: id, service: SERVICE });
    if (!device) return null;
    if (device.kind === 'local') return localEnabled() && device.hostname === os.hostname() ? device : null;
    return String(device.registeredBy) === String(req.user.id) ? device : null;
};

const pickTarget = async (userId, wanted) => {
    if (wanted && mongoose.isValidObjectId(wanted)) {
        const device = await Device.findOne({ _id: wanted, service: SERVICE });
        if (device?.kind === 'companion' && String(device.registeredBy) === String(userId)) return targetOf(device);
        if (device?.kind === 'local' && localEnabled()) return LOCAL_TARGET;
    }
    if (localEnabled()) return LOCAL_TARGET;
    const own = await ownDevices(userId);
    const best = own.find((device) => deviceGateway.isOnline(device.id)) || own[0];
    return best ? targetOf(best) : NO_TARGET;
};

export const useDevice = (req, res, next) => {
    pickTarget(req.user.id, req.get('X-Mollama-Device') || req.query?.device).then((target) => deviceScope.run(target, next), next);
};

const presentDevice = (device, ollama) => ({
    id: device.id,
    name: device.name,
    kind: device.kind,
    service: device.service,
    online: isOnline(device),
    lastSeenAt: device.lastSeenAt,
    hardware: effectiveHardware(device),
    detected: device.hardware,
    overrides: device.overrides,
    edited: Object.values(device.overrides?.toObject?.() || device.overrides || {}).some((value) => value !== null && value !== ''),
    ollama
});


export const listDevices = asyncHandler(async (req, res) => {
    const local = localEnabled() ? await getLocalDevice() : null;
    const devices = [...(local ? [local] : []), ...await ownDevices(req.user.id)];
    const target = currentTarget();

    res.status(200).json({
        success: true,
        devices: await Promise.all(devices.map(async (device) => presentDevice(device, await ollamaOf(device)))),
        current: target.kind === 'companion' ? target.id : local?.id ?? null,
        permissions: { manage: canManage(req) }
    });
});

export const getDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)), permissions: { manage: canManage(req) } });
});

export const updateDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
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

    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});

export const detectDevice = asyncHandler(async (req, res) => {
    const found = await allowedDevice(req, req.params.id);
    if (!found) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    let device = found;
    if (found.kind === 'local') {
        device = await getLocalDevice({ redetect: true });
    } else {
        try {
            found.hardware = await deviceGateway.ask(found.id, 'hardware');
            await found.save();
        } catch (error) {
            return sendOllamaError(res, error);
        }
    }
    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});

export const linkDevice = asyncHandler(async (req, res) => {
    const { hostname, name, hardware } = req.body;
    const key = crypto.randomBytes(32).toString('hex');
    const device = await Device.findOneAndUpdate(
        { service: SERVICE, kind: 'companion', hostname: `${req.user.id}:${hostname}` },
        {
            $set: { keyHash: hashKey(key), registeredBy: req.user.id, lastSeenAt: new Date(), ...(hardware ? { hardware } : {}) },
            $setOnInsert: { name: name || hostname }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    deviceGateway.disconnect(device.id);
    logger.info('[Device] Device linked', { deviceId: device.id, userId: req.user.id });

    res.status(201).json({ success: true, device: { id: device.id, name: device.name }, key });
});

export const unlinkDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device || device.kind !== 'companion') {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    await Device.deleteOne({ _id: device._id });
    deviceGateway.disconnect(device.id);
    getNotificationService().sendToUser(String(req.user.id), { type: 'device:changed', data: { deviceId: device.id, online: false } });
    logger.info('[Device] Device removed', { deviceId: device.id, userId: req.user.id });

    res.status(200).json({ success: true });
});

export const connectDevice = (ws) => deviceGateway.handleConnection(ws, async (hello) => {
    if (!mongoose.isValidObjectId(hello.deviceId) || typeof hello.key !== 'string') return null;
    const device = await Device.findOne({ _id: hello.deviceId, service: SERVICE, kind: 'companion' }).select('+keyHash');
    if (!device?.keyHash) return null;
    const given = Buffer.from(hashKey(hello.key));
    const kept = Buffer.from(device.keyHash);
    if (given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) return null;
    device.lastSeenAt = new Date();
    await device.save();
    return device.id;
});

const announceDevice = (online) => async (deviceId) => {
    try {
        const device = await Device.findOne({ _id: deviceId, service: SERVICE });
        if (!device?.registeredBy) return;
        if (!online) await Device.updateOne({ _id: deviceId }, { lastSeenAt: new Date() });
        getNotificationService().sendToUser(String(device.registeredBy), { type: 'device:changed', data: { deviceId: String(deviceId), online } });
    } catch (error) {
        logger.warn('[Device] Could not announce a device change', { deviceId, error: error.message });
    }
};
deviceGateway.on('online', announceDevice(true));
deviceGateway.on('offline', announceDevice(false));
// Signing out of the desktop app takes that computer off the account.
deviceGateway.on('goodbye', async (deviceId) => {
    try {
        const device = await Device.findOneAndDelete({ _id: deviceId, service: SERVICE, kind: 'companion' });
        if (device?.registeredBy) getNotificationService().sendToUser(String(device.registeredBy), { type: 'device:changed', data: { deviceId: String(deviceId), online: false } });
    } catch (error) {
        logger.warn('[Device] Could not remove a device that signed out', { deviceId, error: error.message });
    }
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
    const target = currentTarget();
    const device = await getCurrentDevice();
    const reachable = Boolean(device) && isOnline(device);
    const ollama = reachable ? await readOllama(await getOllama()) : UNREACHED;
    const problem = !device ? 'NO_DEVICE' : !reachable ? 'DEVICE_OFFLINE' : 'OLLAMA_DOWN';

    res.status(200).json({
        success: true,
        ollama: ollama.available
            ? ollama
            : { ...ollama, ...new OllamaError(problem).toJSON() },
        device: device ? { id: device.id, name: device.name, kind: target.kind, detected: Boolean(device.hardware) } : null,
        steps: {
            ollama: ollama.available,
            device: Boolean(device?.hardware),
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
        basedOn: personal?.from || null,
        system: personal ? personal.system || '' : null,
        parameters: personal ? personal.parameters || {} : null
    };
};

export const listModels = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    const status = await ollama.status();
    const disk = await diskNow();

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
    const hardware = effectiveHardware(await getCurrentDevice());
    let loaded = new Set();
    try {
        loaded = new Set((await ollama.running()).models.map((model) => model.name));
    } catch {
        loaded = new Set();
    }
    for (const model of models) {
        const fit = fitModel(catalogueByTag.get(model.name) || { sizeMb: model.sizeBytes / MB, parameters: parseFloat(model.parameterSize) || 0 }, hardware);
        model.fit = { verdict: fit.verdict, label: fit.label, fits: fit.fits };
        model.ready = loaded.has(model.name);
        model.canChat = !model.capabilities.includes('embedding') || model.capabilities.includes('completion');
        model.usedBy = personal.filter((entry) => entry.from === model.name).map((entry) => entry.displayName);
    }
    models.sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.status(200).json({
        success: true,
        ollamaAvailable: true,
        ollamaVersion: status.version,
        webSearch: webSearchReady(),
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

export const updateModel = asyncHandler(async (req, res) => {
    const name = req.body.name.replace(/:latest$/, '');
    const record = await PersonalModel.findOne({ service: SERVICE, name });
    if (!record) return res.status(404).json({ success: false, message: 'This is not one of your own models.' });
    const displayName = req.body.displayName ?? record.displayName;
    const from = req.body.from ?? record.from;
    const system = req.body.system ?? record.system;
    const parameters = req.body.parameters ?? record.parameters ?? {};

    try {
        const ollama = await getOllama();
        const { models: installed } = await ollama.list();
        const names = new Set(installed.flatMap((model) => [model.name, model.name.replace(/:latest$/, '')]));
        if (!names.has(from) || from.replace(/:latest$/, '') === name) return sendOllamaError(res, new OllamaError('MODEL_MISSING'));
        const request = { model: name, from, stream: false };
        if (system) request.system = system;
        if (Object.keys(parameters).length > 0) request.parameters = parameters;
        await ollama.create(request);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    Object.assign(record, { displayName, from, system, parameters });
    record.markModified('parameters');
    await record.save();
    logger.info('[Models] Personal model updated', { model: name, from, userId: req.user.id });
    res.status(200).json({ success: true, model: { name: record.name, displayName, basedOn: from, system, parameters } });
});

export const startDownload = asyncHandler(async (req, res) => {
    const known = catalogueByTag.get(req.body.name);
    try {
        if (known) {
            const hardware = effectiveHardware(await getCurrentDevice());
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
        reserved: { gpuMemoryMb: GPU_HEADROOM_MB, memoryMb: RAM_RESERVE_MB },
        notes: hasSpecs ? fitNotes(catalogue, hardware) : [],
        models: hasSpecs ? rankCatalogue(catalogue, hardware) : catalogue.map((entry) => ({ ...entry, fit: null, pick: null }))
    });
});

export const getDeviceCatalogue = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    deviceScope.enterWith(targetOf(device));
    const hardware = effectiveHardware(device);
    const installed = await installedNames();
    const disk = await diskNow();

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

const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 4;
const SEARCH_CONTEXT = 16384;
const SEARCH_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web. Returns the title, address and text of the best matching pages.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Read one web page. Returns its text and the addresses of the links on it.',
            parameters: { type: 'object', properties: { url: { type: 'string', description: 'The https address of the page' } }, required: ['url'] }
        }
    }
];

export const webSearchReady = () => searchReady();

const toolInput = (name, raw) => {
    let args = raw;
    if (typeof raw === 'string') {
        try {
            args = JSON.parse(raw);
        } catch {
            args = {};
        }
    }
    return String((name === 'web_fetch' ? args?.url : args?.query) ?? '').trim().slice(0, 500);
};

const clip = (text, limit) => String(text ?? '').slice(0, limit);

// Some models write their tool calls as text instead of making them. Calls written at the end of a reply are run as calls.
export const writtenToolCalls = (text) => {
    const original = String(text ?? '');
    const source = original.replace(/<\/?tool_call>|```(?:json)?/gi, (mark) => ' '.repeat(mark.length));
    const objects = [];
    let depth = 0;
    let start = -1;
    let quoted = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (depth === 0) {
            if (char === '{') {
                depth = 1;
                start = index;
            }
            continue;
        }
        if (quoted) {
            if (char === '\\') index += 1;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) objects.push({ start, end: index + 1 });
    }
    if (depth > 0) return { calls: [], text: original };

    const calls = [];
    let cut = source.length;
    for (const object of objects.reverse()) {
        if (/[^\s,[\]]/.test(source.slice(object.end, cut))) break;
        let parsed;
        try {
            parsed = JSON.parse(source.slice(object.start, object.end));
        } catch {
            break;
        }
        const args = parsed?.arguments ?? parsed?.parameters;
        if (!['web_search', 'web_fetch'].includes(parsed?.name) || !args || typeof args !== 'object') break;
        calls.unshift({ function: { name: parsed.name, arguments: args } });
        cut = object.start;
    }
    if (calls.length === 0) return { calls, text: original };
    return { calls, text: original.slice(0, cut).replace(/(?:\s|\[|<tool_call>|```(?:json)?)+$/i, '') };
};

const runSearchTool = async (name, input) => {
    const text = (content) => ({ content, failed: null });
    try {
        if (!input) return text('The tool was called with nothing to look up.');
        if (name === 'web_search') {
            const results = (await searchWeb(input)).map((result) => ({ title: clip(result.title, 200), url: result.url, content: clip(result.content, 1500) }));
            return text(results.length > 0 ? JSON.stringify(results) : 'The search found nothing.');
        }
        if (name === 'web_fetch') {
            if (!/^https:\/\//i.test(input)) return text('web_fetch needs a full address that starts with https://');
            const page = await readPage(input);
            return text(JSON.stringify({ title: clip(page?.title, 200), content: clip(page?.content, 8000), links: (page?.links || []).slice(0, 80) }));
        }
        return text(`There is no tool called ${name}.`);
    } catch (error) {
        const failed = error?.code === 'SEARCH_REFUSED' ? 'refused' : error?.code === 'SEARCH_LIMITED' ? 'limited' : error?.code === 'REMOTE_BLOCKED' ? 'blocked' : 'unreachable';
        const detail = error?.detail ? ` (${String(error.detail).slice(0, 200)})` : '';
        logger.warn('[Chat] Web tool failed', { tool: name, code: error?.code || null, detail });
        return { content: `Error: ${String(error?.message || 'the request failed').slice(0, 300)}${detail}`, failed };
    }
};

const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_ATTACHMENT_CHARS = 2000000;
const AUTO_CONTEXT_LIMIT = 32768;
const CONTEXT_STEPS = [8192, 16384, AUTO_CONTEXT_LIMIT];
const REPLY_RESERVE = 1024;
const CONTEXT_WARN_PERCENT = 75;

export const queue = new GenerationQueue();
const busyChats = new Set();
const liveReplies = new Map();
const queuedTurns = new Map();
const MAX_QUEUED_TURNS = 5;

const applyQueueSettings = async () => {
    const settings = await getSettings();
    queue.maxConcurrent = settings.maxConcurrentGenerations;
    return settings;
};

const modelFacts = async (ollama, name) => {
    const shown = await ollama.show(name);
    return { contextLength: contextLength(shown) || 4096, capabilities: shown.capabilities || [] };
};

const capacityFor = (chat, facts) => {
    const chosen = Number(chat.options?.num_ctx) || 0;
    return chosen > 0 ? Math.min(chosen, facts.contextLength) : Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT);
};

const GUIDE_PARTS = fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'ai.components.md'), 'utf8').replace(/\r\n/g, '\n').split(/\n=== ([A-Z ]+) ===\n/);
const guidePart = (name) => (GUIDE_PARTS[GUIDE_PARTS.indexOf(name) + 1] || '').trim();
export const COMPONENT_GUIDE = GUIDE_PARTS[0].trim();
export const SEARCH_GUIDE = guidePart('WEB SEARCH');
export const PLAN_GUIDE = guidePart('SEARCH PLAN');
export const RESULTS_GUIDE = guidePart('WEB RESULTS');
export const REVIEW_GUIDE = guidePart('SEARCH REVIEW');

const MAX_PROMPTS = 100;

const cleanInstruction = (item) => ({
    name: item.name,
    text: item.text,
    source: item.source === 'fs-one' ? 'fs-one' : SERVICE,
    path: item.source === 'fs-one' ? item.path || null : null
});

const instructionsOf = (chat) => {
    if (chat.instructions?.length > 0) return chat.instructions.map(cleanInstruction);
    if (!chat.system) return [];
    return [{ name: 'Instructions', text: chat.system, source: chat.systemSource ? 'fs-one' : SERVICE, path: chat.systemSource || null }];
};

const systemText = (chat) => {
    const items = instructionsOf(chat);
    if (items.length <= 1) return items[0]?.text || '';
    return items.map((item) => `# ${item.name}\n\n${item.text}`).join('\n\n');
};

const buildMessages = (chat) => {
    const out = [];
    const system = [COMPONENT_GUIDE, systemText(chat), chat.summary && `Summary of the earlier conversation:\n${chat.summary}`].filter(Boolean).join('\n\n');
    if (system) out.push({ role: 'system', content: system });
    for (const message of chat.messages) {
        if (!message.content) continue;
        let content = message.content;
        if (message.role === 'user' && message.attachmentIds.length > 0) {
            const documents = message.attachmentIds
                .map((id) => chat.attachments.id(id))
                .filter(Boolean)
                .map((attachment) => `Document "${attachment.name}":\n${attachment.text}`);
            if (documents.length > 0) content = `${documents.join('\n\n')}\n\n${content}`;
        }
        out.push({ role: message.role, content });
    }
    return out;
};

const promptTokens = (messages) => messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);

const contextUse = (chat, facts) => {
    if (!facts) return null;
    const capacity = capacityFor(chat, facts);
    const pending = chat.attachments.filter((attachment) => !attachment.sent).reduce((sum, attachment) => sum + attachment.tokens, 0);
    const last = [...chat.messages].reverse().find((message) => message.role === 'assistant' && message.stats?.promptEvalCount);
    const measured = last ? last.stats.promptEvalCount + (last.stats.evalCount || 0) : 0;
    const used = Math.max(promptTokens(buildMessages(chat)), measured) + pending;
    const percent = Math.min(100, Math.round((used / capacity) * 100));
    return { usedTokens: used, capacityTokens: capacity, percent, warn: percent >= CONTEXT_WARN_PERCENT };
};

const presentAttachment = (attachment) => ({
    id: attachment.id,
    name: attachment.name,
    source: attachment.source,
    path: attachment.path,
    chars: attachment.chars,
    tokens: attachment.tokens
});

const presentMessage = (chat, message, index) => ({
    id: message.id,
    index,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    model: message.model,
    stats: message.stats?.evalCount ? message.stats : null,
    error: message.errorCode ? new OllamaError(message.errorCode).toJSON() : null,
    stopped: message.stopped,
    steps: (message.steps || []).map((step) => ({ tool: step.tool, input: step.input, failed: step.failed || null })),
    unverified: message.unverified || [],
    attachments: message.attachmentIds.map((id) => chat.attachments.id(id)).filter(Boolean).map(presentAttachment),
    createdAt: message.createdAt
});

const presentChat = (chat, facts = null) => ({
    id: chat.id,
    title: chat.title,
    model: chat.model,
    system: systemText(chat),
    systemSource: chat.systemSource,
    instructions: instructionsOf(chat),
    summary: chat.summary,
    continuedFrom: chat.continuedFrom,
    options: chat.options || {},
    messages: chat.messages.map((message, index) => presentMessage(chat, message, index)),
    pendingAttachments: chat.attachments.filter((attachment) => !attachment.sent).map(presentAttachment),
    context: contextUse(chat, facts),
    replying: liveReplies.has(chat.id),
    queued: [...(queuedTurns.get(chat.id) || [])],
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
});

const factsOrNull = async (chat) => {
    if (!chat.model) return null;
    try {
        return await modelFacts(await getOllama(), chat.model);
    } catch {
        return null;
    }
};

const findChat = async (req, res) => {
    const chat = await Chat.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    if (!chat) res.status(404).json({ success: false, message: 'Chat not found' });
    return chat;
};

const titleFrom = (content) => {
    const line = String(content).replace(/\s+/g, ' ').trim();
    if (line.length <= 60) return line || 'New chat';
    const cut = line.slice(0, 60);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
};

const chooseModel = async (ollama, userId) => {
    const { models } = await ollama.list();
    if (models.length === 0) throw new OllamaError('NO_MODELS');
    const names = new Set(models.map((model) => model.name));
    const settings = await getSettings();
    if (settings.defaultModel && names.has(settings.defaultModel)) return settings.defaultModel;

    const recent = await Chat.findOne({ service: SERVICE, owner: userId, model: { $ne: null } }).sort({ updatedAt: -1 }).select('model');
    if (recent && names.has(recent.model)) return recent.model;

    const hardware = effectiveHardware(await getCurrentDevice());
    const usable = models.filter((model) => !/embed/i.test(model.name));
    const sized = (usable.length > 0 ? usable : models)
        .map((model) => ({ name: model.name, size: model.size || 0, fit: fitModel({ sizeMb: (model.size || 0) / MB, parameters: 0 }, hardware) }))
        .sort((a, b) => b.size - a.size);
    return (sized.find((model) => model.fit.verdict === 'gpu' || model.fit.verdict === 'cpu') || sized[sized.length - 1]).name;
};

const applyChatFields = (chat, body) => {
    for (const key of ['title', 'model', 'system', 'options']) {
        if (key in body) chat[key] = body[key];
    }
    if ('system' in body) chat.instructions = [];
    if ('instructions' in body) {
        chat.instructions = body.instructions.map(cleanInstruction);
        chat.system = '';
        chat.systemSource = null;
    }
    if ('title' in body) chat.titled = true;
    if ('system' in body) chat.systemSource = body.systemSource || null;
    if ('options' in body) chat.markModified('options');
};

export const listChats = asyncHandler(async (req, res) => {
    const filter = { service: SERVICE, owner: req.user.id };
    const search = String(req.query.search || '').trim();
    if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const chats = await Chat.find(filter).sort({ updatedAt: -1 }).limit(200).select('title model updatedAt createdAt');
    res.status(200).json({
        success: true,
        chats: chats.map((chat) => ({ id: chat.id, title: chat.title, model: chat.model, updatedAt: chat.updatedAt, createdAt: chat.createdAt }))
    });
});

export const createChat = asyncHandler(async (req, res) => {
    const chat = new Chat({ owner: req.user.id });
    applyChatFields(chat, req.body || {});
    await chat.save();
    res.status(201).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const getChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const updateChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    applyChatFields(chat, req.body);
    await chat.save();
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const deleteChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    await chat.deleteOne();
    logger.info('[Chat] Chat deleted', { chatId: chat.id, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Chat deleted.' });
});

const prepareTurn = (chat, body) => {
    if (body.regenerate) {
        while (chat.messages.length > 0 && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
        return chat.messages.length > 0 ? null : 'There is no message to answer again.';
    }
    if (body.editIndex !== undefined) {
        const target = chat.messages[body.editIndex];
        if (!target || target.role !== 'user') return 'Only one of your own messages can be edited.';
        const attachmentIds = [...target.attachmentIds];
        chat.messages.splice(body.editIndex);
        chat.messages.push({ role: 'user', content: body.content, attachmentIds });
        return null;
    }
    const waiting = chat.attachments.filter((attachment) => !attachment.sent);
    waiting.forEach((attachment) => {
        attachment.sent = true;
    });
    chat.messages.push({ role: 'user', content: body.content, attachmentIds: waiting.map((attachment) => attachment._id) });
    return null;
};

const FILE_TYPES = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply', '3mf', 'dae', 'pdf', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'png', 'jpg', 'gif', 'webp', 'svg', 'csv', 'json', 'md', 'txt'];
const MEDIA_TYPES = ['png', 'jpg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mp3', 'wav', 'ogg'];
const CONTENT_TYPES = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf', 'model/obj': 'obj', 'model/stl': 'stl', 'text/csv': 'csv', 'application/json': 'json', 'text/markdown': 'md'
};
const PLAN_FORMAT = {
    type: 'object',
    properties: {
        note: { type: 'string' },
        searches: {
            type: 'array',
            items: {
                type: 'object',
                properties: { query: { type: 'string' }, fileTypes: { type: 'array', items: { type: 'string' } } },
                required: ['query', 'fileTypes']
            }
        }
    },
    required: ['note', 'searches']
};
const REVIEW_FORMAT = {
    type: 'object',
    properties: {
        enough: { type: 'boolean' },
        searches: PLAN_FORMAT.properties.searches,
        pages: {
            type: 'array',
            items: {
                type: 'object',
                properties: { url: { type: 'string' }, fileTypes: { type: 'array', items: { type: 'string' } } },
                required: ['url', 'fileTypes']
            }
        }
    },
    required: ['enough', 'searches', 'pages']
};
const MAX_SEARCHES = 8;
const DEEPER_ROUNDS = 12;
const IDLE_ROUNDS = 2;
const MAX_DEEPER = 4;
const MIN_NEW_WORDS = 2;
const MAX_SHARED_WORDS = 0.6;
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'from', 'by', 'at', 'as', 'is', 's']);
const queryWords = (query) => [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !SMALL_WORDS.has(word)))];
const MAX_RESULTS_CHARS = 24000;
const PAGES_PER_SEARCH = 3;
const FILES_PER_SEARCH = 6;
const CHECKS_PER_SEARCH = 14;

const plainType = (value) => String(value || '').toLowerCase().replace(/^\./, '').replace(/^jpeg$/, 'jpg');
const typeOfAddress = (address) => {
    try {
        return plainType(path.extname(new URL(address).pathname));
    } catch {
        return '';
    }
};
const typeOfContent = (contentType) => CONTENT_TYPES[String(contentType || '').toLowerCase().split(';')[0].trim()] || null;

const IMAGE_TYPES = ['png', 'jpg', 'gif', 'webp'];
const MIN_IMAGE_BYTES = 15000;

const checkFile = async (address, wanted) => {
    try {
        const loaded = await fetchRemote(address);
        loaded.stream.destroy?.();
        const said = String(loaded.contentType || '').toLowerCase();
        if (said.includes('html')) return null;
        const type = typeOfContent(said) || typeOfAddress(address);
        if (!wanted.includes(type)) return null;
        if (IMAGE_TYPES.includes(type) && loaded.size && loaded.size < MIN_IMAGE_BYTES) return null;
        return { url: address, type };
    } catch {
        return null;
    }
};

const rawAddress = (address) => {
    const match = String(address).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : address;
};

// The app runs the web search itself: the model only writes the queries, in a fixed JSON shape.
export const gatherWeb = async ({ ollama, chat, facts, keepAlive, numCtx, write, steps, stopped, prefix = null, track = null }) => {
    const known = new Set();
    const usable = new Set();
    for (const message of chat.messages) {
        if (message.role !== 'user') continue;
        (String(message.content).match(/https?:\/\/[^\s"'<>)\]]+/g) || []).forEach((address) => {
            known.add(address);
            usable.add(address);
        });
    }
    const pageReads = new Map();
    const openPage = (address) => {
        if (!pageReads.has(address)) pageReads.set(address, readPage(address));
        return pageReads.get(address);
    };
    const fileChecks = new Map();
    const checkOnce = (address, wanted) => {
        const key = `${wanted.join(',')} ${address}`;
        if (!fileChecks.has(key)) fileChecks.set(key, checkFile(address, wanted));
        return fileChecks.get(key);
    };
    const keep = (file) => {
        known.add(file.url);
        usable.add(file.url);
    };
    const lastUser = [...chat.messages].reverse().find((message) => message.role === 'user');
    const question = clip(lastUser?.content, 4000);
    const ask = async (format, guide, content) => {
        const request = {
            model: chat.model,
            stream: true,
            format,
            messages: prefix ? [...prefix, { role: 'user', content: `${guide}\n\n${content}` }] : [{ role: 'system', content: guide }, { role: 'user', content }],
            options: { temperature: 0, num_ctx: numCtx },
            keep_alive: keepAlive
        };
        if (facts.capabilities.includes('thinking')) request.think = false;
        try {
            if (stopped()) return {};
            const stream = await ollama.chat(request);
            if (track) track(stream);
            let text = '';
            for await (const part of stream) text += part.message?.content || '';
            return JSON.parse(text || '{}') || {};
        } catch (error) {
            logger.warn('[Chat] Search plan could not be read', { message: String(error?.message || '').slice(0, 200) });
            return {};
        }
    };
    const cleanTypes = (list) => [...new Set((Array.isArray(list) ? list : []).map(plainType).filter((type) => FILE_TYPES.includes(type)))];
    const cleanSearches = (list) => (Array.isArray(list) ? list : [])
        .map((search) => ({ query: String(search?.query ?? '').trim().slice(0, 200), types: cleanTypes(search?.fileTypes) }))
        .filter((search) => search.query);
    const plan = await ask(PLAN_FORMAT, PLAN_GUIDE, `THE USER'S MESSAGE\n${question}`);
    const searches = cleanSearches(plan.searches).slice(0, MAX_SEARCHES);
    const planNote = String(plan.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (planNote) write({ type: 'note', text: planNote });
    const openedPages = new Set();

    const sections = [];
    const note = (tool, input) => {
        const step = { tool, input, failed: null };
        steps.push(step);
        write({ type: 'tool', tool, input });
        return step;
    };
    let limited = false;
    const runSearch = async (search) => {
        if (stopped() || limited) return;
        const lines = [`SEARCH: ${search.query}`];
        const pagesSeen = [];
        const files = [];
        const look = async (query) => {
            const step = note('web_search', query);
            let results;
            try {
                results = (await searchWeb(query)).filter((result) => /^https:\/\//i.test(result.url));
            } catch (error) {
                step.failed = error?.code === 'SEARCH_REFUSED' ? 'refused' : error?.code === 'SEARCH_LIMITED' ? 'limited' : 'unreachable';
                if (step.failed === 'limited') limited = true;
                write({ type: 'toolFailed', failed: step.failed });
                return false;
            }
            results.forEach((result) => known.add(result.url));
            pagesSeen.push(...results.filter((result) => !pagesSeen.some((seen) => seen.url === result.url)));

            const opened = results.slice(0, search.types.length > 0 ? PAGES_PER_SEARCH : 1);
            opened.forEach((result) => {
                if (!openedPages.has(result.url)) note('web_fetch', result.url);
                openedPages.add(result.url);
            });
            const pages = await Promise.allSettled(opened.map((result) => openPage(result.url)));
            const candidates = results.map((result) => result.url).filter((link) => search.types.includes(typeOfAddress(link))).map(rawAddress);
            pages.forEach((outcome, index) => {
                if (outcome.status !== 'fulfilled') return;
                const page = outcome.value;
                const address = opened[index].url;
                const direct = typeOfContent(page.file);
                if (direct && search.types.includes(direct) && !files.some((file) => file.url === address)) {
                    files.push({ url: address, type: direct });
                    keep({ url: address });
                }
                page.links.forEach((link) => known.add(link));
                page.media.forEach((link) => known.add(link));
                candidates.push(...[...page.links, ...page.embedded].filter((link) => search.types.includes(typeOfAddress(link))).map(rawAddress));
                page.embedded.filter((link) => search.types.includes(typeOfAddress(link))).forEach((link) => known.add(link));
                if (search.types.some((type) => MEDIA_TYPES.includes(type))) candidates.push(...page.media);
                if (search.types.length === 0 && page.content) lines.push(`Text of ${address}:`, clip(page.content, 2500));
            });
            if (search.types.length > 0) {
                const unique = [...new Set(candidates)].filter((link) => !files.some((file) => file.url === link)).slice(0, CHECKS_PER_SEARCH);
                const checked = (await Promise.all(unique.map((link) => checkOnce(link, search.types)))).filter(Boolean);
                checked.forEach((file) => keep(file));
                files.push(...checked);
            }
            return true;
        };

        const ran = await look(search.query);
        if (ran && search.types.length > 0 && files.length === 0 && !stopped()) await look(`${search.query} filetype:${search.types[0]}`);
        if (!ran) {
            sections.push(`SEARCH: ${search.query}\n${limited ? 'The search service is limiting requests right now, so this search could not be run.' : 'This search could not be run, so nothing was found for it.'}`);
            return;
        }
        if (search.types.length > 0) {
            lines.push(`Files found (${search.types.join(', ')}; each one was loaded successfully; use these in src):`);
            lines.push(...(files.length > 0 ? files.slice(0, FILES_PER_SEARCH).map((file) => `- ${file.url} (${file.type})`) : ['- none']));
        }
        lines.push('Pages (web pages, never for src; give as plain links):', ...pagesSeen.slice(0, 3).map((result) => `- ${clip(result.title, 100)} | ${result.url} | ${clip(result.content, 160).replace(/\s+/g, ' ')}`));
        sections.push(lines.join('\n'));
    };
    const runPage = async (target) => {
        if (stopped()) return;
        note('web_fetch', target.url);
        let page;
        try {
            page = await openPage(target.url);
        } catch {
            sections.push(`PAGE: ${target.url}\nThis page could not be opened.`);
            return;
        }
        page.links.forEach((link) => known.add(link));
        page.media.forEach((link) => known.add(link));
        const lines = [`PAGE: ${target.url}`];
        if (target.types.length === 0) {
            if (page.content) lines.push('Text of this page:', clip(page.content, 2500));
            sections.push(lines.join('\n'));
            return;
        }
        const direct = typeOfContent(page.file);
        const files = direct && target.types.includes(direct) ? [{ url: target.url, type: direct }] : [];
        files.forEach((file) => keep(file));
        const candidates = [...page.links, ...page.embedded].filter((link) => target.types.includes(typeOfAddress(link))).map(rawAddress);
        if (target.types.some((type) => MEDIA_TYPES.includes(type))) candidates.push(...page.media);
        const checked = (await Promise.all([...new Set(candidates)].slice(0, CHECKS_PER_SEARCH).map((link) => checkOnce(link, target.types)))).filter(Boolean);
        checked.forEach((file) => keep(file));
        files.push(...checked);
        lines.push(`Files found on this page (${target.types.join(', ')}; each one was loaded successfully; use these in src):`);
        lines.push(...(files.length > 0 ? files.slice(0, FILES_PER_SEARCH).map((file) => `- ${file.url} (${file.type})`) : ['- none']));
        sections.push(lines.join('\n'));
    };
    for (const search of searches) await runSearch(search);

    const useful = (section) => /^- https\S* \(\w+\)$/m.test(section) || /^Text of /m.test(section);
    const resultsText = () => {
        const whole = sections.join('\n\n');
        if (whole.length <= MAX_RESULTS_CHARS) return whole;
        const shorter = sections.map((section) => (useful(section) ? section : section.split('\n').filter((line, index) => index === 0 || /^Files found|^- none$|^This /.test(line)).join('\n')));
        return clip(shorter.join('\n\n'), MAX_RESULTS_CHARS);
    };
    const gained = () => usable.size + sections.filter((section) => /^Text of /m.test(section)).length;

    const ran = searches.map((search) => search.query);
    const usedWords = new Set(ran.flatMap(queryWords));
    const differs = (query) => {
        const words = queryWords(query);
        if (words.filter((word) => !usedWords.has(word)).length < MIN_NEW_WORDS) return false;
        return ran.every((earlier) => {
            const other = new Set(queryWords(earlier));
            const shared = words.filter((word) => other.has(word)).length;
            return shared / new Set([...words, ...other]).size < MAX_SHARED_WORDS;
        });
    };
    let idle = 0;
    let checkFrom = 0;
    for (let round = 0; round < DEEPER_ROUNDS && idle < IDLE_ROUNDS && sections.slice(checkFrom).some((section) => !useful(section)) && !limited && !stopped(); round++) {
        const review = await ask(REVIEW_FORMAT, REVIEW_GUIDE, `THE USER'S MESSAGE\n${question}\n\nFOUND SO FAR\n\n${resultsText()}\n\nSEARCHES ALREADY RUN\n${ran.map((query) => `- ${query}`).join('\n')}\n\nWORDS ALREADY SEARCHED\n${[...usedWords].join(', ')}`);
        if (review.enough !== false) break;
        const more = [];
        for (const search of cleanSearches(review.searches)) {
            if (more.length >= MAX_DEEPER || !differs(search.query)) continue;
            more.push(search);
            ran.push(search.query);
            queryWords(search.query).forEach((word) => usedWords.add(word));
        }
        const pages = (Array.isArray(review.pages) ? review.pages : [])
            .map((page) => ({ url: String(page?.url ?? '').trim(), types: cleanTypes(page?.fileTypes) }))
            .filter((page, index, all) => /^https:\/\//i.test(page.url) && known.has(page.url) && !openedPages.has(page.url) && all.findIndex((other) => other.url === page.url) === index)
            .slice(0, MAX_DEEPER);
        if (more.length === 0 && pages.length === 0) break;
        pages.forEach((page) => openedPages.add(page.url));
        checkFrom = sections.length;
        const before = gained();
        for (const search of more) await runSearch(search);
        for (const page of pages) await runPage(page);
        idle = gained() > before ? 0 : idle + 1;
    }
    return { known, usable, text: sections.length > 0 ? `WEB RESULTS\n\n${resultsText()}` : '' };
};

const runTurn = async ({ chat, body, userId, res, live }) => {
    if (!body.regenerate && body.editIndex === undefined && chat.messages.length >= MAX_CHAT_MESSAGES) {
        if (res) sendOllamaError(res, new OllamaError('CHAT_FULL'));
        return;
    }

    const problem = prepareTurn(chat, body);
    if (problem) {
        if (res) res.status(400).json({ success: false, message: problem });
        return;
    }
    if (!chat.titled && chat.messages.filter((message) => message.role === 'user').length === 1) {
        chat.title = titleFrom(chat.messages[0].content);
    }

    let ollama;
    let facts;
    let settings;
    let prompt;
    try {
        settings = await applyQueueSettings();
        ollama = await getOllama();
        if (!(await ollama.status()).available) throw new OllamaError('OLLAMA_DOWN');
        if (!chat.model) chat.model = await chooseModel(ollama, userId);
        facts = await modelFacts(ollama, chat.model);

        prompt = buildMessages(chat);
        const needed = promptTokens(prompt) + REPLY_RESERVE;
        if (needed > capacityFor(chat, facts)) {
            const lastUser = chat.messages[chat.messages.length - 1];
            throw new OllamaError(lastUser.attachmentIds.length > 0 ? 'DOCUMENT_TOO_LONG' : 'TOO_LONG');
        }
        if (queue.waitingFor(userId) >= queue.perUserLimit) throw new OllamaError('QUEUE_FULL');
    } catch (error) {
        const failure = mapOllamaError(error);
        if (res) return sendOllamaError(res, failure);
        chat.messages.push({ role: 'assistant', model: chat.model, content: '', errorCode: failure.code });
        await chat.save();
        return;
    }

    await chat.save();

    if (res) {
        res.req.setTimeout(0);
        res.setTimeout(0);
        res.status(200).set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        live.listeners.add(res);
        res.on('close', () => live.listeners.delete(res));
    }

    let gone = live.stopped;
    let onStop = null;
    const stopSignal = new Promise((resolve) => {
        onStop = resolve;
    });
    let stream = null;
    let job = null;
    const write = (event) => {
        const last = live.events[live.events.length - 1];
        if ((event.type === 'token' || event.type === 'thinking') && last?.type === event.type) last.text += event.text;
        else live.events.push({ ...event });
        const line = `${JSON.stringify(event)}\n`;
        for (const listener of live.listeners) {
            if (!listener.writableEnded) listener.write(line);
        }
    };
    const reportPlace = () => {
        if (job?.state === 'waiting') write({ type: 'queued', ahead: job.ahead() });
    };
    live.stop = () => {
        gone = true;
        job?.cancel();
        stream?.abort?.();
        onStop();
    };

    write({ type: 'accepted', chat: { id: chat.id, title: chat.title, model: chat.model }, messageCount: chat.messages.length });

    const reply = { content: '', thinking: '', stats: {}, errorCode: null, stopped: false, steps: [], unverified: [] };
    const run = async () => {
        if (gone) return;
        const loaded = await ollama.running().then((list) => list.models.some((entry) => entry.name === chat.model)).catch(() => true);
        write({ type: 'start', sharing: queue.running.size - 1, loaded });
        const appSearch = webSearchReady() && process.env.WEB_SEARCH_MODE !== 'tools';
        const searching = webSearchReady() && !appSearch && facts.capabilities.includes('tools');
        const messages = [...prompt];
        if (searching) messages[0] = { role: 'system', content: `${messages[0].content}\n\n${SEARCH_GUIDE}` };
        const capacity = capacityFor(chat, facts);
        const sizeFor = (list, extra = 0) => {
            const fitted = CONTEXT_STEPS.find((step) => step >= promptTokens(list) + REPLY_RESERVE + extra) || capacity;
            return Number(chat.options?.num_ctx) > 0 ? capacity : Math.min(capacity, searching || appSearch ? Math.max(fitted, SEARCH_CONTEXT) : fitted);
        };
        const searchCtx = sizeFor(messages, Math.ceil(MAX_RESULTS_CHARS / 4));
        let found = null;
        if (appSearch) {
            messages[0] = { role: 'system', content: `${messages[0].content}\n\n${RESULTS_GUIDE}` };
            try {
                found = await Promise.race([stopSignal.then(() => null), gatherWeb({
                    ollama,
                    chat,
                    facts,
                    keepAlive: `${settings.keepAliveMinutes}m`,
                    numCtx: searchCtx,
                    prefix: messages.slice(0, -1),
                    write,
                    steps: reply.steps,
                    stopped: () => gone,
                    track: (planning) => {
                        stream = planning;
                        if (gone) planning.abort?.();
                    }
                })]);
            } catch (error) {
                logger.warn('[Chat] Web results could not be gathered', { message: String(error?.message || '').slice(0, 200) });
            }
            const last = messages[messages.length - 1];
            if (found?.text && last?.role === 'user') messages[messages.length - 1] = { role: 'user', content: `${found.text}\n\nTHE USER'S MESSAGE\n${last.content}` };
        }
        const numCtx = appSearch ? searchCtx : sizeFor(messages);
        let evalCount = 0;
        let evalSeconds = 0;
        let totalMs = 0;
        let promptEvalCount = null;

        try {
            for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                if (gone) break;
                const request = {
                    model: chat.model,
                    messages,
                    stream: true,
                    options: { num_predict: numCtx, ...(chat.options || {}), num_ctx: numCtx },
                    keep_alive: `${settings.keepAliveMinutes}m`
                };
                if (facts.capabilities.includes('thinking')) request.think = true;
                if (searching && round < MAX_TOOL_ROUNDS) request.tools = SEARCH_TOOLS;

                const calls = [];
                let said = '';
                stream = await ollama.chat(request);
                if (gone) stream.abort?.();
                for await (const part of stream) {
                    if (part.message?.thinking) {
                        reply.thinking += part.message.thinking;
                        write({ type: 'thinking', text: part.message.thinking });
                    }
                    if (part.message?.content) {
                        said += part.message.content;
                        reply.content += part.message.content;
                        write({ type: 'token', text: part.message.content });
                    }
                    if (Array.isArray(part.message?.tool_calls)) calls.push(...part.message.tool_calls);
                    if (part.done) {
                        evalCount += part.eval_count || 0;
                        evalSeconds += (part.eval_duration || 0) / 1e9;
                        totalMs += part.total_duration ? part.total_duration / 1e6 : 0;
                        promptEvalCount = part.prompt_eval_count || promptEvalCount;
                    }
                }
                if (calls.length === 0 && request.tools && !gone) {
                    const written = writtenToolCalls(said);
                    if (written.calls.length > 0) {
                        calls.push(...written.calls);
                        reply.content = reply.content.slice(0, reply.content.length - said.length) + written.text;
                        write({ type: 'replace', text: reply.content });
                        said = written.text;
                    }
                }
                if (calls.length === 0 || gone) break;
                calls.splice(MAX_TOOL_CALLS);

                messages.push({ role: 'assistant', content: said, tool_calls: calls });
                for (const call of calls) {
                    const name = String(call.function?.name || '');
                    const input = toolInput(name, call.function?.arguments);
                    const step = { tool: name, input, failed: null };
                    reply.steps.push(step);
                    write({ type: 'tool', tool: name, input });
                    const outcome = await runSearchTool(name, input);
                    if (outcome.failed) {
                        step.failed = outcome.failed;
                        write({ type: 'toolFailed', failed: outcome.failed });
                    }
                    messages.push({ role: 'tool', tool_name: name, content: outcome.content });
                    if (gone) break;
                }
                if (said && !/\s$/.test(reply.content)) {
                    reply.content += '\n\n';
                    write({ type: 'token', text: '\n\n' });
                }
            }
        } catch (error) {
            if (gone) reply.stopped = true;
            else reply.errorCode = mapOllamaError(error).code;
        }
        reply.stats = {
            evalCount: evalCount || null,
            promptEvalCount,
            durationMs: totalMs ? Math.round(totalMs) : null,
            tokensPerSecond: evalSeconds > 0 && evalCount ? Math.round((evalCount / evalSeconds) * 10) / 10 : null
        };
        if (gone) reply.stopped = true;
        if (found) {
            const used = [...reply.content.matchAll(/\bsrc\s*=\s*"(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
            reply.unverified = [...new Set(used.filter((address) => !found.usable.has(address)))];
        }
    };

    try {
        job = queue.add({ userId, priority: 'interactive', run });
        queue.on('moved', reportPlace);
        await job.done;
    } catch (error) {
        reply.errorCode = mapOllamaError(error).code;
    } finally {
        queue.off('moved', reportPlace);
    }

    if (reply.content || reply.errorCode) {
        chat.messages.push({ role: 'assistant', model: chat.model, ...reply });
    }
    try {
        await chat.save();
    } catch (error) {
        logger.error('[Chat] Reply could not be saved', { chatId: chat.id, message: error.message });
    }

    const last = chat.messages[chat.messages.length - 1];
    const message = last?.role === 'assistant' ? presentMessage(chat, last, chat.messages.length - 1) : null;
    if (reply.content && !reply.stopped && !reply.errorCode) {
        getNotificationService().notify(userId, 'reply:finished', { level: 'info', title: 'Reply ready', message: `The reply in "${chat.title}" is ready.`, chatId: chat.id, path: `/chat/${chat.id}` });
    }
    write({
        type: reply.errorCode ? 'error' : 'done',
        ...(reply.errorCode ? new OllamaError(reply.errorCode).toJSON() : {}),
        reply: message,
        title: chat.title,
        context: contextUse(chat, facts)
    });
};

const openLive = (id) => {
    const live = { events: [], listeners: new Set(), stop: null, stopped: false };
    liveReplies.set(id, live);
    return live;
};

const takeTurns = async (chat, body, userId, res) => {
    const id = chat.id;
    busyChats.add(id);
    let turn = { chat, body, res, live: openLive(id) };
    getNotificationService().notify(userId, 'activity:changed');
    try {
        while (turn) {
            try {
                if (turn.chat) await runTurn({ ...turn, userId });
            } catch (error) {
                logger.error('[Chat] Turn failed', { chatId: id, message: String(error?.message || '').slice(0, 200) });
                if (turn.res && !turn.res.headersSent) turn.res.status(500).json({ success: false, message: 'The message could not be sent.' });
            }
            for (const listener of turn.live.listeners) {
                if (!listener.writableEnded) listener.end();
            }
            const content = queuedTurns.get(id)?.shift();
            if (content === undefined) break;
            const live = openLive(id);
            const next = await Chat.findOne({ _id: id, service: SERVICE, owner: userId }).catch(() => null);
            turn = { chat: next, body: { content }, res: null, live };
        }
    } finally {
        liveReplies.delete(id);
        queuedTurns.delete(id);
        busyChats.delete(id);
        getNotificationService().notify(userId, 'activity:changed');
    }
};

export const sendMessage = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    if (!busyChats.has(chat.id)) return takeTurns(chat, req.body, req.user.id, res);
    if (req.body.regenerate || req.body.editIndex !== undefined) {
        return res.status(409).json({ success: false, message: 'This chat is still replying. Stop it or wait for it to finish.' });
    }
    const waiting = queuedTurns.get(chat.id) || [];
    if (waiting.length >= MAX_QUEUED_TURNS) return sendOllamaError(res, new OllamaError('QUEUE_FULL'));
    waiting.push(req.body.content);
    queuedTurns.set(chat.id, waiting);
    res.status(202).json({ success: true, queued: [...waiting] });
});

const RECENT_DOWNLOAD_MS = 2 * 60 * 1000;

export const getActivity = asyncHandler(async (req, res) => {
    const ids = [...liveReplies.keys()];
    const chats = ids.length > 0
        ? await Chat.find({ _id: { $in: ids }, service: SERVICE, owner: req.user.id }).select('title model')
        : [];
    const jobs = (await downloads.list()).filter((job) => ['queued', 'downloading'].includes(job.status)
        || (['completed', 'failed'].includes(job.status) && job.finishedAt && Date.now() - new Date(job.finishedAt).getTime() < RECENT_DOWNLOAD_MS));
    res.status(200).json({
        success: true,
        replies: chats.map((chat) => ({ chatId: chat.id, title: chat.title, model: chat.model, waiting: (queuedTurns.get(chat.id) || []).length })),
        downloads: jobs.map((job) => ({ id: job.id, model: job.model, status: job.status, percent: job.percent })),
        permissions: { manage: canManage(req) }
    });
});

export const rejoinReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const live = liveReplies.get(chat.id);
    if (!live) return res.status(204).end();
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    for (const event of live.events) res.write(`${JSON.stringify(event)}\n`);
    live.listeners.add(res);
    res.on('close', () => live.listeners.delete(res));
});

export const stopReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const live = liveReplies.get(chat.id);
    queuedTurns.delete(chat.id);
    if (live) {
        live.stopped = true;
        live.stop?.();
    }
    res.status(200).json({ success: true, stopped: Boolean(live) });
});

export const loadModel = asyncHandler(async (req, res) => {
    try {
        const settings = await applyQueueSettings();
        const ollama = await getOllama();
        if (!(await ollama.status()).available) throw new OllamaError('OLLAMA_DOWN');
        const model = req.body?.name || await chooseModel(ollama, req.user.id);
        const loaded = (await ollama.running()).models.some((entry) => entry.name === model);
        const busy = queue.running.size > 0 || queue.waiting.length > 0;
        const loading = !loaded && !busy && settings.keepAliveMinutes > 0;
        if (loading) {
            const facts = await modelFacts(ollama, model);
            const appSearch = webSearchReady() && process.env.WEB_SEARCH_MODE !== 'tools';
            const numCtx = Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT, appSearch ? SEARCH_CONTEXT : CONTEXT_STEPS[0]);
            ollama.load(model, `${settings.keepAliveMinutes}m`, numCtx).catch((error) => {
                logger.warn('[Models] Model could not be loaded ahead of time', { model, code: mapOllamaError(error).code });
            });
        }
        res.status(202).json({ success: true, model, ready: loaded, loading });
    } catch (error) {
        sendOllamaError(res, mapOllamaError(error));
    }
});

export const summariseChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    if (chat.messages.length === 0) {
        return res.status(400).json({ success: false, message: 'There is nothing to summarise yet.' });
    }
    req.setTimeout(0);
    res.setTimeout(0);

    let summary;
    try {
        const settings = await applyQueueSettings();
        const ollama = await getOllama();
        const facts = await modelFacts(ollama, chat.model);
        const capacity = capacityFor(chat, facts);
        const ask = {
            role: 'user',
            content: 'Summarise this conversation so that it can be continued in a new chat. Include the goal, the key facts, decisions made and open questions. Use short bullet points. Do not add anything that was not said.'
        };
        const prompt = buildMessages(chat);
        const first = prompt[0]?.role === 'system' ? 1 : 0;
        while (prompt.length > first + 1 && promptTokens(prompt) + REPLY_RESERVE + 100 > capacity) prompt.splice(first, 1);
        prompt.push(ask);

        const job = queue.add({
            userId: req.user.id,
            priority: 'interactive',
            run: () => ollama.chat({
                model: chat.model,
                messages: prompt,
                stream: false,
                options: { ...(chat.options || {}), num_ctx: capacity },
                keep_alive: `${settings.keepAliveMinutes}m`
            })
        });
        summary = String((await job.done)?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (!summary) throw new OllamaError('UNKNOWN');
    } catch (error) {
        return sendOllamaError(res, mapOllamaError(error));
    }

    const next = await Chat.create({
        owner: req.user.id,
        title: `${chat.title} (continued)`.slice(0, 120),
        titled: true,
        model: chat.model,
        system: chat.system,
        systemSource: chat.systemSource,
        instructions: chat.instructions,
        options: chat.options,
        summary,
        continuedFrom: chat._id
    });
    res.status(201).json({ success: true, chat: presentChat(next, await factsOrNull(next)) });
});

const readUpload = express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES });

export const receiveUpload = (req, res, next) => {
    readUpload(req, res, (error) => {
        if (!error) return next();
        if (error.type === 'entity.too.large') return sendOllamaError(res, new OllamaError('FILE_TOO_LARGE'));
        return next(error);
    });
};

const filesFor = (req) => createFilesClient({ baseUrl: process.env.FILESYSTEM_ONE_URL, accessToken: req.cookies?.accessToken });

const invalid = (res, error) => res.status(400).json({
    success: false,
    message: `Validation error: ${error.details.map((detail) => detail.message.replace(/['"]/g, '')).join(', ')}`
});

export const addAttachment = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;

    let document;
    try {
        if (Buffer.isBuffer(req.body)) {
            const { error, value } = chatSchemas.attachUpload.validate(req.query);
            if (error) return invalid(res, error);
            document = { name: value.name, source: SERVICE, path: null, text: await extractText({ buffer: req.body, name: value.name }) };
        } else {
            const { error, value } = chatSchemas.attachFile.validate(req.body);
            if (error) return invalid(res, error);
            const file = await filesFor(req).text(value.path);
            document = { name: file.name, source: 'fs-one', path: value.path, text: file.text };
        }

        const tokens = estimateTokens(document.text);
        const facts = await factsOrNull(chat);
        const held = chat.attachments.reduce((sum, attachment) => sum + attachment.chars, 0);
        if (held + document.text.length > MAX_CHAT_ATTACHMENT_CHARS) throw new OllamaError('DOCUMENT_TOO_LONG');
        if (facts) {
            const capacity = capacityFor(chat, facts);
            const room = capacity - REPLY_RESERVE - (contextUse(chat, facts)?.usedTokens || 0);
            if (tokens > room) {
                const error = new OllamaError('DOCUMENT_TOO_LONG');
                return res.status(error.status).json({
                    success: false,
                    ...error.toJSON(),
                    message: `This document needs about ${tokens.toLocaleString('en-GB')} tokens and this chat has room for about ${Math.max(0, room).toLocaleString('en-GB')}.`,
                    neededTokens: tokens,
                    roomTokens: Math.max(0, room)
                });
            }
        }
        chat.attachments.push({ ...document, chars: document.text.length, tokens });
    } catch (error) {
        return sendOllamaError(res, error);
    }

    await chat.save();
    res.status(201).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const removeAttachment = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const attachment = chat.attachments.id(req.params.attachmentId);
    if (!attachment || attachment.sent) {
        return res.status(404).json({ success: false, message: 'Attachment not found' });
    }
    attachment.deleteOne();
    await chat.save();
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';

const exportChatText = (chat, format) => {
    if (format === 'jsonl') {
        const lines = [];
        if (systemText(chat)) lines.push({ role: 'system', content: systemText(chat) });
        for (const message of chat.messages) {
            const line = { role: message.role, content: message.content, createdAt: message.createdAt };
            if (message.role === 'assistant') line.model = message.model;
            const names = message.attachmentIds.map((id) => chat.attachments.id(id)?.name).filter(Boolean);
            if (names.length > 0) line.attachments = names;
            lines.push(line);
        }
        return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    }
    const parts = [`# ${chat.title}`, `Model: ${chat.model || 'none'}`];
    if (systemText(chat)) parts.push(`## Instructions\n\n${systemText(chat)}`);
    for (const message of chat.messages) {
        const names = message.attachmentIds.map((id) => chat.attachments.id(id)?.name).filter(Boolean);
        const attached = names.length > 0 ? `\n\n_Attached: ${names.join(', ')}_` : '';
        parts.push(`## ${message.role === 'user' ? 'You' : message.model || 'Assistant'}\n\n${message.content}${attached}`);
    }
    return `${parts.join('\n\n')}\n`;
};

export const exportChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const format = req.query.format === 'jsonl' ? 'jsonl' : 'markdown';
    const fileName = `${slugify(chat.title)}.${format === 'jsonl' ? 'jsonl' : 'md'}`;
    res.status(200).json({ success: true, fileName, format, content: exportChatText(chat, format) });
});

const presentPrompt = (prompt) => ({
    id: prompt.id, name: prompt.name, text: prompt.text, source: prompt.source, path: prompt.path, updatedAt: prompt.updatedAt
});

const guideFor = async (req) => Guide.findOneAndUpdate(
    { service: SERVICE, user: req.user.id },
    { $setOnInsert: { on: true, seen: [] } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
);
const guideSteps = (req) => (canManage(req) ? GUIDE_STEPS : GUIDE_STEPS.filter((step) => !MANAGER_GUIDE_STEPS.includes(step)));
const presentGuide = (req, guide) => ({ on: guide.on, seen: guide.seen, steps: guideSteps(req) });

export const getGuide = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, guide: presentGuide(req, await guideFor(req)) });
});

export const updateGuide = asyncHandler(async (req, res) => {
    const guide = await guideFor(req);
    guide.on = req.body.on;
    if (req.body.on) guide.seen = [];
    await guide.save();
    res.status(200).json({ success: true, guide: presentGuide(req, guide) });
});

export const markGuideSeen = asyncHandler(async (req, res) => {
    const guide = await guideFor(req);
    if (guide.on && !guide.seen.includes(req.body.key)) {
        guide.seen.push(req.body.key);
        if (guideSteps(req).every((step) => guide.seen.includes(step))) guide.on = false;
        await guide.save();
    }
    res.status(200).json({ success: true, guide: presentGuide(req, guide) });
});

export const listPrompts = asyncHandler(async (req, res) => {
    const prompts = await Prompt.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 }).limit(MAX_PROMPTS);
    res.status(200).json({ success: true, prompts: prompts.map(presentPrompt) });
});

export const createPrompt = asyncHandler(async (req, res) => {
    if (await Prompt.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_PROMPTS) {
        return res.status(422).json({ success: false, message: 'You have 100 saved instructions, which is the limit.', action: 'Delete one you no longer use.' });
    }
    const prompt = await Prompt.create({ owner: req.user.id, ...cleanInstruction(req.body) });
    res.status(201).json({ success: true, prompt: presentPrompt(prompt) });
});

const findPrompt = async (req, res) => {
    const prompt = await Prompt.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    if (!prompt) res.status(404).json({ success: false, message: 'Saved instruction not found' });
    return prompt;
};

export const updatePrompt = asyncHandler(async (req, res) => {
    const prompt = await findPrompt(req, res);
    if (!prompt) return;
    for (const key of ['name', 'text']) {
        if (key in req.body) prompt[key] = req.body[key];
    }
    await prompt.save();
    res.status(200).json({ success: true, prompt: presentPrompt(prompt) });
});

export const deletePrompt = asyncHandler(async (req, res) => {
    const prompt = await findPrompt(req, res);
    if (!prompt) return;
    await prompt.deleteOne();
    res.status(200).json({ success: true, message: 'Saved instruction deleted.' });
});

export const browseFiles = asyncHandler(async (req, res) => {
    const folder = req.query.path || '/';
    try {
        const entries = await filesFor(req).browse(folder);
        const parent = folder === '/' ? null : folder.slice(0, folder.lastIndexOf('/')) || '/';
        res.status(200).json({ success: true, path: folder, parent, entries });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const readFileText = asyncHandler(async (req, res) => {
    try {
        const file = await filesFor(req).text(req.query.path);
        const tokens = estimateTokens(file.text);
        let capacityTokens = null;
        if (req.query.model) {
            try {
                capacityTokens = Math.min((await modelFacts(await getOllama(), req.query.model)).contextLength, AUTO_CONTEXT_LIMIT);
            } catch {
                capacityTokens = null;
            }
        }
        res.status(200).json({
            success: true,
            name: file.name,
            path: req.query.path,
            text: file.text,
            chars: file.text.length,
            tokens,
            capacityTokens,
            fits: capacityTokens === null ? null : tokens + REPLY_RESERVE <= capacityTokens
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const loadRemote = asyncHandler(async (req, res) => {
    let remote;
    try {
        remote = await fetchRemote(req.query.url);
    } catch (error) {
        return sendOllamaError(res, error instanceof OllamaError ? error : new OllamaError('REMOTE_FAILED', error.message));
    }
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300'
    });
    let total = 0;
    remote.stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_REMOTE_BYTES) {
            remote.stream.destroy();
            res.destroy();
        }
    });
    remote.stream.on('error', () => res.destroy());
    remote.stream.pipe(res);
});

export const saveFile = asyncHandler(async (req, res) => {
    try {
        const saved = await filesFor(req).save(req.body.folder, req.body.name, req.body.content);
        res.status(201).json({ success: true, path: saved.path, message: `Saved to ${saved.path}` });
    } catch (error) {
        sendOllamaError(res, error);
    }
});
