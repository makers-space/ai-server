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
import { SERVICE, Device, Setting, PersonalModel, Download, Chat, Prompt, Guide, GUIDE_STEPS, MANAGER_GUIDE_STEPS, chatSchemas, ToolServer, Provider, Skill } from '../models/ai.model.js';
import {
    OllamaError, mapOllamaError, createOllamaClient, libraryModels, libraryEntries, loadLibrarySizes, librarySizes, friendlyName, cloudTitle, computerName, detectHardware, appleGpus, readDisk, rankCatalogue, fitModel, fitNotes, GPU_HEADROOM_MB, RAM_RESERVE_MB,
    GenerationQueue, estimateTokens, extractText, createFilesClient, MAX_ATTACHMENT_BYTES, fetchRemote, MAX_REMOTE_BYTES,
    searchReady, searchWeb, readPage, deviceGateway,
    CLOUD_PROVIDERS, PROVIDER_HEALTH, createCloudClient, ollamaOnlineNames, runsOnline,
    TOOL_HEALTH, TOOL_CATALOGUE, TOOL_LOCAL_CATALOGUE, toolKeyNeeded, listedTool, seal, unseal, accountKeeper, withToolServer, finishToolSignIn, readTools, toolFault, ToolSignInError
} from '../middleware/ai.middleware.js';

const MB = 1024 * 1024;
// Models seen in the live list from ollama.com, remembered so installed models can show their description and size.
const knownModels = new Map();
const hostName = (address) => {
    try {
        return new URL(address).hostname.replace(/^www\./, '');
    } catch {
        return 'Source';
    }
};
const CATALOGUE_PAGE = 48;
const SAMPLE = { full: 6, mixed: 3, large: 3 };
const POPULAR_MODELS = 40;
const PICK_ORDER = { fast: 0, balanced: 1, best: 2, code: 3, reasoning: 3 };
const CLOUD_FIT = { verdict: 'cloud', label: 'Cloud only', fits: false, memoryNeededMb: 0, tokensPerSecond: null };
// The whole library, searched and ordered on the server and handed out a page at a time.
// Recommendations come only from the most downloaded models, so an obscure model is never the suggestion.
const liveCatalogue = async (query, hardware) => {
    const models = await libraryModels();
    const words = String(query?.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const page = Number(query?.page) || 1;
    const size = Number(query?.size) || CATALOGUE_PAGE;
    // How the list under the recommendations is ordered; the recommendations themselves always come first.
    const ORDERS = {
        largest: (a, b) => (b.sizeMb || 0) - (a.sizeMb || 0),
        smallest: (a, b) => (a.sizeMb || 0) - (b.sizeMb || 0),
        popular: (a, b) => (b.pulls || 0) - (a.pulls || 0),
        name: (a, b) => String(a.tag).localeCompare(String(b.tag))
    };
    const chosenOrder = ORDERS[query?.sort] || null;
    const popular = new Set([...models].sort((a, b) => b.pulls - a.pulls).slice(0, POPULAR_MODELS).map((model) => model.name));
    const matching = models.filter((model) => words.every((word) => `${model.name} ${model.description}`.toLowerCase().includes(word)));
    await loadLibrarySizes(matching.filter((model) => popular.has(model.name)).map((model) => model.name));

    const order = () => {
        const entries = libraryEntries(matching);
        const isPopular = (entry) => !entry.cloudOnly && popular.has(entry.tag.split(':')[0]);
        const all = hardware
            ? [...rankCatalogue(entries.filter(isPopular), hardware), ...entries.filter((entry) => !isPopular(entry)).map((entry) => ({ ...entry, fit: entry.cloudOnly ? CLOUD_FIT : fitModel(entry, hardware), pick: null }))]
            : entries.map((entry) => ({ ...entry, fit: null, pick: null }));
        return all.sort((a, b) => (PICK_ORDER[a.pick] ?? 9) - (PICK_ORDER[b.pick] ?? 9)
            || (chosenOrder ? chosenOrder(a, b) || a.parameters - b.parameters : 0)
            || Number(a.cloudOnly) - Number(b.cloudOnly)
            || Number(b.fit?.fits ?? true) - Number(a.fit?.fits ?? true)
            || b.pulls - a.pulls
            || a.parameters - b.parameters);
    };
    const everything = query?.all === true || query?.all === 'true';
    // The public home page shows a taste of the list: models that run fully here, some that need help from system memory, and a few that are too large.
    const sampled = Boolean(hardware) && (query?.sample === true || query?.sample === 'true');
    const dice = Math.random();
    const sample = (all) => {
        const local = all.filter((entry) => !entry.cloudOnly);
        const large = local.filter((entry) => entry.fit.verdict === 'too_large');
        const start = Math.floor(dice * large.length);
        const step = Math.max(1, Math.floor(large.length / SAMPLE.large));
        const picked = [...new Set(Array.from({ length: Math.min(SAMPLE.large, large.length) }, (_, index) => large[(start + index * step) % large.length]))];
        return [
            ...local.filter((entry) => entry.fit.verdict === 'gpu' || entry.fit.verdict === 'cpu').slice(0, SAMPLE.full),
            ...local.filter((entry) => entry.fit.verdict === 'mixed').slice(0, SAMPLE.mixed),
            ...picked
        ];
    };
    // The recommended models lead the first page and are not counted in the number shown per page.
    const unpicked = (all) => all.filter((entry) => !entry.pick);
    const shown = (all) => (sampled ? sample(all) : everything ? all
        : [...(page === 1 ? all.filter((entry) => entry.pick) : []), ...unpicked(all).slice((page - 1) * size, page * size)]);

    // The page about to be shown gets its exact sizes, then the order is worked out again with them.
    await loadLibrarySizes(shown(order()).map((entry) => entry.tag.split(':')[0]));
    const all = order();
    const entries = shown(all);
    const online = await ollamaOnlineNames();
    entries.forEach((entry) => { entry.online = runsOnline(entry, online); });
    entries.forEach((entry) => knownModels.set(entry.tag, entry));
    loadLibrarySizes(models.map((model) => model.name)).catch(() => {});

    return {
        all,
        entries,
        query: words.join(' '),
        page,
        size,
        paged: unpicked(all).length,
        more: !everything && !sampled && page * size < unpicked(all).length,
        local: all.filter((entry) => !entry.cloudOnly),
        total: all.length,
        library: models.length,
        fitting: hardware ? all.filter((entry) => entry.fit.fits).length : null
    };
};

const canManage = (req) => hasRight(req.user.roles, RIGHTS.MANAGE_MODELS);

// Once a change has been answered successfully, the person's other open apps are told, so their pages bring themselves
// up to date. The first part of the path, when it is an id, says which chat or computer changed.
export const announceChanges = (type, quiet = []) => (req, res, next) => {
    // The path is read now: by the time the answer has gone out it no longer starts where this part of the router does.
    const path = req.path;
    res.on('finish', () => {
        if (req.method === 'GET' || res.statusCode >= 300 || !req.user?.id || quiet.includes(path)) return;
        const id = path.match(/^\/([0-9a-f]{24})(?:\/|$)/)?.[1] || null;
        const removed = req.method === 'DELETE' && /^\/[0-9a-f]{24}\/?$/.test(path);
        getNotificationService().sendToUser(String(req.user.id), { type, data: { id, removed } });
    });
    next();
};

const RESUME_WINDOW_MS = 30 * 60 * 1000;

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
// A Mollama server is never one of a person's computers, in development, staging or production: models run only on
// computers linked through the desktop app. Only the test suite can switch this on, to stand in for a computer with
// Ollama; no setting turns it on for a running server.
const localEnabled = () => process.env.NODE_ENV === 'test' && process.env.LOCAL_DEVICE === 'true';
const currentTarget = () => deviceScope.getStore() || (localEnabled() ? LOCAL_TARGET : NO_TARGET);
// Paused computers stay connected but are given no work. The set follows the saved flag each time a computer is looked up.
const pausedDevices = new Set();
const targetOf = (device) => {
    if (device.kind !== 'companion') return LOCAL_TARGET;
    if (device.paused) pausedDevices.add(String(device.id));
    else pausedDevices.delete(String(device.id));
    return { kind: 'companion', id: String(device.id) };
};
const targetPaused = () => {
    const target = currentTarget();
    return target.kind === 'companion' && pausedDevices.has(target.id);
};

const currentLane = () => {
    const target = currentTarget();
    return target.kind === 'companion' ? target.id : target.kind === 'cloud' ? `cloud:${target.id}` : target.kind;
};

const getOllama = async () => {
    const target = currentTarget();
    if (target.kind === 'cloud') {
        const provider = await Provider.findOne({ _id: target.id, service: SERVICE }).select('+sealed');
        const entry = CLOUD_PROVIDERS.find((one) => one.id === provider?.kind);
        const key = provider ? unseal(provider.sealed)?.key : null;
        if (!entry || !key) return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('KEY_REFUSED')));
        return createCloudClient(entry, key, provider.models);
    }
    if (target.kind === 'companion' && pausedDevices.has(target.id)) return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('DEVICE_PAUSED')));
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
            device: doc.device ? String(doc.device) : null,
            createdAt: doc.createdAt,
            finishedAt: live.finishedAt !== undefined ? live.finishedAt : doc.finishedAt
        };
    }

    announce(doc) {
        this.emit('progress', this.present(doc));
    }

    async list() {
        const docs = await Download.find({ service: SERVICE, device: currentTarget().id }).sort({ createdAt: -1 }).limit(30);
        return docs.map((doc) => this.present(doc));
    }

    // A progress save is not waited for, so it can arrive after the save that ends the download. It must not undo that one.
    save(doc, fields, { final = false, attempt = 0 } = {}) {
        return within(Download.updateOne(final ? { _id: doc._id } : { _id: doc._id, status: { $nin: FINAL_STATES } }, fields), this.saveWaitMs)
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
            const stale = await Download.find({ service: SERVICE, model, device: currentTarget().id, status: 'failed', _id: { $ne: keepId } });
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

        const device = currentTarget().id;
        const open = await Download.find({ service: SERVICE, model, device, status: { $in: OPEN_STATES } });
        let doc = open.find((candidate) => !FINAL_STATES.includes(this.live.get(candidate.id)?.status)) || null;

        if (doc && this.active?.id !== doc.id && (this.live.get(doc.id)?.status ?? doc.status) === 'paused') {
            this.live.delete(doc.id);
            doc.status = 'queued';
            doc.errorCode = null;
            await doc.save();
        }
        if (!doc) {
            doc = await Download.findOne({ service: SERVICE, model, device, status: 'failed' }).sort({ createdAt: -1 });
            if (doc) {
                this.live.delete(doc.id);
                Object.assign(doc, { status: 'queued', errorCode: null, finishedAt: null, requestedBy: userId });
                await doc.save();
            }
        }
        if (!doc) doc = await Download.create({ model, requestedBy: userId, device });
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
        // The record is saved before the live state says finished, so no page reads "completed" ahead of the record.
        await this.save(doc, result, { final: true });
        Object.assign(state, { status: outcome, errorCode, finishedAt: result.finishedAt, stalled: false, speedBps: 0 });

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

    // A download that failed because its computer dropped off the connection is taken up again when that computer
    // returns. Ollama keeps what was already fetched, so it carries on from there.
    async resumeFor(deviceId) {
        const waiting = await Download.find({
            service: SERVICE,
            device: deviceId,
            status: 'failed',
            errorCode: { $in: ['DEVICE_OFFLINE', 'DOWNLOAD_INTERRUPTED'] },
            finishedAt: { $gte: new Date(Date.now() - RESUME_WINDOW_MS) }
        });
        if (waiting.length === 0) return 0;
        for (const doc of waiting) {
            this.live.delete(doc.id);
            doc.status = 'queued';
            doc.errorCode = null;
            doc.finishedAt = null;
            await doc.save();
            this.announce(doc);
        }
        logger.info(`[Downloads] Resuming ${waiting.length} download(s) on a computer that came back`, { deviceId: String(deviceId) });
        getNotificationService().broadcast('activity:changed');
        this.next();
        return waiting.length;
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
    if (target.kind === 'none' || target.kind === 'cloud') return null;
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
        gpuShared: !overrides.gpuName && /built-in graphics$/.test(gpuName || ''),
        cpu: detected.cpu || null,
        cpuThreads: detected.cpuThreads || null,
        diskFreeMb: detected.diskFreeMb ?? null,
        diskTotalMb: detected.diskTotalMb ?? null,
        platform: detected.platform || null
    };
};

// Models that only make embeddings cannot hold a chat, so they are counted apart: a computer with only those is not ready to chat.
const embedsOnly = (model) => /bert/i.test(model.details?.family || '') || /embed/i.test(model.name || '');
const readOllama = async (client) => {
    const status = await client.status();
    if (!status.available) return { ...status, modelCount: 0, chatCount: 0 };
    try {
        const { models } = await client.list();
        return { ...status, modelCount: models.length, chatCount: models.filter((model) => !embedsOnly(model)).length };
    } catch {
        return { ...status, modelCount: 0, chatCount: 0 };
    }
};

const UNREACHED = { available: false, version: null, modelCount: 0, chatCount: 0 };
const isOnline = (device) => device.kind === 'local' || deviceGateway.isOnline(device.id);
const ollamaOf = (device) => (device.paused
    ? { ...UNREACHED, paused: true }
    : isOnline(device) ? deviceScope.run(targetOf(device), async () => readOllama(await getOllama())) : UNREACHED);
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
        if (!device && await Provider.exists({ _id: wanted, service: SERVICE, owner: userId })) return { kind: 'cloud', id: String(wanted) };
    }
    if (localEnabled()) return LOCAL_TARGET;
    const own = await ownDevices(userId);
    const best = own.find((device) => deviceGateway.isOnline(device.id) && !device.paused) || own.find((device) => deviceGateway.isOnline(device.id)) || own[0];
    return best ? targetOf(best) : NO_TARGET;
};

export const useDevice = (req, res, next) => {
    pickTarget(req.user.id, req.get('X-Mollama-Device') || req.query?.device).then((target) => deviceScope.run(target, next), next);
};

// A computer still called by its network name is shown with a readable one; a name the person gave is kept as it is.
const shownName = (device) => (device.kind === 'companion' && device.name === String(device.hostname || '').split(':').slice(1).join(':') ? computerName(device.name) : device.name);

const presentDevice = (device, ollama) => ({
    id: device.id,
    name: shownName(device),
    kind: device.kind,
    service: device.service,
    online: isOnline(device),
    lastSeenAt: device.lastSeenAt,
    hardware: effectiveHardware(device),
    detected: device.hardware,
    overrides: device.overrides,
    paused: Boolean(device.paused),
    edited: Object.values(device.overrides?.toObject?.() || device.overrides || {}).some((value) => value !== null && value !== ''),
    ollama
});


export const listDevices = asyncHandler(async (req, res) => {
    const local = localEnabled() ? await getLocalDevice() : null;
    const devices = [...(local ? [local] : []), ...await ownDevices(req.user.id)];
    const target = currentTarget();

    res.status(200).json({
        success: true,
        devices: [
            ...await Promise.all(devices.map(async (device) => presentDevice(device, await ollamaOf(device)))),
            ...(req.query?.with === 'online' ? (await Provider.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 })).map(presentOnlineDevice) : [])
        ],
        current: target.kind === 'companion' || target.kind === 'cloud' ? target.id : local?.id ?? null,
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
    // The computer's own name, when the desktop app sends one, replaces a name that is still only its network name.
    if (name && device.name === hostname && name !== hostname) {
        device.name = name;
        await device.save();
    }
    deviceGateway.disconnect(device.id);
    logger.info('[Device] Device linked', { deviceId: device.id, userId: req.user.id });

    res.status(201).json({ success: true, device: { id: device.id, name: shownName(device) }, key });
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

// Pausing keeps the computer connected but gives it no work, and takes its loaded models out of memory first.
const setPaused = (paused) => asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device || device.kind !== 'companion') {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (paused && !device.paused && deviceGateway.isOnline(device.id)) {
        await deviceScope.run(targetOf(device), async () => {
            const ollama = await getOllama();
            const { models } = await ollama.running();
            await Promise.all(models.map((model) => ollama.unload(model.name)));
        }).catch((error) => logger.warn('[Device] Models could not be unloaded before pausing', { deviceId: device.id, message: String(error?.message || '').slice(0, 200) }));
    }
    device.paused = paused;
    await device.save();
    targetOf(device);
    getNotificationService().sendToUser(String(req.user.id), { type: 'device:changed', data: { deviceId: device.id, online: deviceGateway.isOnline(device.id), paused } });
    logger.info(paused ? '[Device] Device paused' : '[Device] Device resumed', { deviceId: device.id, userId: req.user.id });

    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});
export const pauseDevice = setPaused(true);
export const resumeDevice = setPaused(false);

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

const announceDevice = (online) => async (deviceId, hello, replaced = false) => {
    // A computer that reconnects while still counted as online has not changed, so nobody is told.
    if (replaced) return;
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
deviceGateway.on('online', (deviceId) => {
    downloads.resumeFor(deviceId).catch((error) => logger.warn('[Downloads] Could not resume downloads for a returning computer', { deviceId: String(deviceId), error: error.message }));
});
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
    // An online service is not a computer: it counts as ready, and its own state is shown on the Models page.
    if (target.kind === 'cloud') {
        return res.status(200).json({ success: true, ready: target.id, account: { available: true }, ollama: { available: true, version: null, modelCount: 0 }, device: null, steps: { ollama: true, device: true, model: true } });
    }
    const device = await getCurrentDevice();
    const reachable = Boolean(device) && isOnline(device);
    const ollama = reachable ? await readOllama(await getOllama()) : UNREACHED;
    const problem = !device ? 'NO_DEVICE' : device.paused ? 'DEVICE_PAUSED' : !reachable ? 'DEVICE_OFFLINE' : 'OLLAMA_DOWN';

    // Any of the person's computers will do, so the others are asked before anything is called a problem.
    let ready = ollama.available ? device.id : null;
    let count = device ? 1 : 0;
    if (!ready) {
        const local = localEnabled() ? await getLocalDevice() : null;
        const others = [...(local ? [local] : []), ...await ownDevices(req.user.id)].filter((other) => other.id !== device?.id);
        count += others.length;
        const answers = await Promise.all(others.map((other) => Promise.resolve(ollamaOf(other)).catch(() => UNREACHED)));
        ready = others[answers.findIndex((answer) => answer.available)]?.id || null;
    }

    res.status(200).json({
        success: true,
        ready,
        account: ready ? { available: true } : { available: false, ...new OllamaError(count > 1 ? 'NOTHING_READY' : problem).toJSON() },
        ollama: ollama.available
            ? ollama
            : { ...ollama, ...new OllamaError(problem).toJSON() },
        device: device ? { id: device.id, name: shownName(device), kind: target.kind, detected: Boolean(device.hardware) } : null,
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

// A model's details only change when the model itself does, so they are asked for once per computer and version.
const shownModels = new Map();
const showOnce = async (ollama, model) => {
    const key = `${currentLane()}|${model.name}|${model.digest || model.modified_at || ''}`;
    if (shownModels.has(key)) return shownModels.get(key);
    const shown = await ollama.show(model.name);
    if (shownModels.size >= 500) shownModels.delete(shownModels.keys().next().value);
    shownModels.set(key, shown);
    return shown;
};

const describeInstalled = async (ollama, model, personalByName) => {
    let shown = null;
    try {
        shown = await showOnce(ollama, model);
    } catch {
        shown = null;
    }
    const known = knownModels.get(model.name);
    const friendly = friendlyName(model.name);
    const personal = personalByName.get(model.name) || personalByName.get(model.name.replace(/:latest$/, ''));

    return {
        name: model.name,
        displayName: personal?.displayName || known?.name || friendly,
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

// The models of an online provider, in the same shape as the models on a computer so the picker needs no second path.
const listOnlineModels = async (req, res) => {
    const provider = await Provider.findOne({ _id: currentTarget().id, service: SERVICE });
    const models = (provider?.models || []).map((model) => ({
        name: model.name, displayName: model.title || knownModels.get(model.name.replace(/[-:]cloud$/i, ''))?.name || cloudTitle(model.name), description: '', sizeBytes: 0, family: null, parameterSize: null, quantization: null,
        contextLength: model.contextLength || null, capabilities: ['completion', 'tools', ...(model.vision ? ['vision'] : [])], modifiedAt: null, personal: false,
        fit: { verdict: 'cloud', label: 'Online', fits: true }, ready: true, canChat: true, usedBy: []
    }));
    res.status(200).json({ success: true, device: currentTarget().id || null, ollamaAvailable: provider?.health === 'healthy', ollamaVersion: null, webSearch: false, models, disk: { usedByModelsMb: 0, freeMb: 0, totalMb: 0 }, online: true, permissions: { manage: false } });
};

export const listModels = asyncHandler(async (req, res) => {
    if (currentTarget().kind === 'cloud') return listOnlineModels(req, res);
    const ollama = await getOllama();
    const status = await ollama.status();
    const disk = await diskNow();

    if (!status.available) {
        return res.status(200).json({
            success: true,
            device: currentTarget().id || null,
            ollamaAvailable: false,
            ollamaVersion: null,
            webSearch: webSearchReady(),
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
        const fit = fitModel(knownModels.get(model.name) || { sizeMb: model.sizeBytes / MB, parameters: parseFloat(model.parameterSize) || 0 }, hardware);
        model.fit = { verdict: fit.verdict, label: fit.label, fits: fit.fits };
        model.ready = loaded.has(model.name);
        model.canChat = !model.capabilities.includes('embedding') || model.capabilities.includes('completion');
        model.usedBy = personal.filter((entry) => entry.from === model.name).map((entry) => entry.displayName);
    }
    models.sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.status(200).json({
        success: true,
        device: currentTarget().id || null,
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
                    displayName: knownModels.get(model.name)?.name || friendlyName(model.name),
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

// One model looked up in the library by its Ollama name, with its exact size, whether or not the list was opened first.
const findModel = async (tag) => {
    if (knownModels.has(tag)) return knownModels.get(tag);
    try {
        const base = String(tag).split(':')[0];
        const model = (await libraryModels()).find((entry) => entry.name === base);
        if (!model) return null;
        await loadLibrarySizes([base]);
        const found = libraryEntries([model]).find((entry) => entry.tag === tag && !entry.cloudOnly) || null;
        if (found) knownModels.set(tag, found);
        return found;
    } catch {
        return null;
    }
};

export const startDownload = asyncHandler(async (req, res) => {
    const known = await findModel(req.body.name);
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
            sizeHintMb: known?.sizeMb || (await librarySizes(String(req.body.name).split(':')[0])).get(String(req.body.name).split(':')[1] || 'latest') || null
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

    const watched = currentTarget().id;
    const onProgress = (job) => { if (job.device === watched) send('progress', job); };
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
    const hardware = { memoryMb: Number(memoryMb) || 0, gpuMemoryMb: Number(gpuMemoryMb) || 0, gpuShared: req.query.shared === true || req.query.shared === 'true' };
    let live;
    try {
        live = await liveCatalogue(req.query, hasSpecs ? hardware : null);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    res.status(200).json({
        success: true,
        source: 'ollama.com',
        query: live.query,
        page: live.page,
        size: live.size,
        paged: live.paged,
        more: live.more,
        total: live.total,
        library: live.library,
        fitting: live.fitting,
        hardware: hasSpecs ? hardware : null,
        reserved: { gpuMemoryMb: GPU_HEADROOM_MB, memoryMb: RAM_RESERVE_MB },
        notes: hasSpecs ? fitNotes(live.local, hardware) : [],
        models: live.entries
    });
});

export const getDeviceCatalogue = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    deviceScope.enterWith(targetOf(device));
    const hardware = effectiveHardware(device);
    let live;
    try {
        live = await liveCatalogue(req.query, hardware);
    } catch (error) {
        return sendOllamaError(res, error);
    }
    const installed = await installedNames();
    const disk = await diskNow();

    res.status(200).json({
        success: true,
        source: 'ollama.com',
        query: live.query,
        page: live.page,
        size: live.size,
        paged: live.paged,
        more: live.more,
        total: live.total,
        library: live.library,
        fitting: live.fitting,
        hardware,
        freeDiskMb: disk.diskFreeMb,
        models: live.entries.map((entry) => ({
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
    return { contextLength: contextLength(shown) || 4096, capabilities: shown.capabilities || [], online: Object.keys(shown?.model_info || {}).some((key) => key.startsWith('cloud.')) };
};

// How much a model may be given to read. A model on a computer is held to a limit that protects the computer's memory;
// an online model reads as much as its service says it can.
const capacityFor = (chat, facts) => {
    const chosen = Number(chat.options?.num_ctx) || 0;
    if (chosen > 0) return Math.min(chosen, facts.contextLength);
    return facts.online ? facts.contextLength : Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT);
};

// What the models are told lives in server/instructions, and all of it is skills a chat turns on or off: skills/ holds
// the one skill of Mollama's own, which makes its viewers work, and library/ holds skills from other projects, one
// folder per project. Nothing else is sent: no base instructions, no tool rules, no search rules. Credits and licences
// are in THIRD_PARTY.md.
const INSTRUCTIONS = path.join(import.meta.dirname, '..', 'instructions');
const readGuide = (file) => {
    const text = fs.readFileSync(path.join(INSTRUCTIONS, file), 'utf8').replace(/\r\n/g, '\n');
    const head = text.match(/^---\n([\s\S]*?)\n---\n/);
    const facts = Object.fromEntries((head?.[1] || '').split('\n').map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
    const parts = `\n${text.slice(head?.[0].length || 0)}`.split(/\n=== ([A-Z ]+) ===\n/);
    return { facts, body: parts[0].trim(), part: (name) => (parts.includes(name) ? parts[parts.indexOf(name) + 1] : '').trim() };
};
const OWN_SKILLS = fs.readdirSync(path.join(INSTRUCTIONS, 'skills')).filter((file) => file.endsWith('.md')).map((file) => {
    const guide = readGuide(path.join('skills', file));
    return {
        id: file.slice(0, -3),
        name: guide.facts.name || file.slice(0, -3),
        description: guide.facts.description || '',
        default: guide.facts.default === 'true',
        order: Number(guide.facts.order) || 99,
        credit: guide.facts.credit || null,
        source: 'mollama',
        needs: [],
        text: guide.body,
        remember: guide.part('REMEMBER')
    };
}).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

// The projects the library's skills come from, in the order they are listed.
export const SKILL_SOURCES = {
    mollama: { name: 'Mollama', repo: null },
    mine: { name: 'My skills', repo: null },
    anthropic: { name: 'Anthropic', repo: 'anthropics/skills' },
    engineering: { name: 'Engineering (Matt Pocock)', repo: 'mattpocock/skills' },
    marketing: { name: 'Marketing (Corey Haines)', repo: 'coreyhaines31/marketingskills' },
    medical: { name: 'Medical (Open Medica)', repo: 'Open-Medica/open-medical-skills' },
    dex: { name: 'Chief of staff (Dex)', repo: 'davekilleen/dex' },
    context7: { name: 'Context7', repo: 'upstash/context7' },
    search: { name: 'Web search (Perplexica, Morphic)', repo: 'ItzCrazyKns/Perplexica, miurla/morphic' },
    last30days: { name: 'Last 30 days', repo: 'mvanhorn/last30days-skill' },
    anatomy: { name: 'Anatomy', repo: 'wheresryan22/anatomy' },
    hairline: { name: 'Hairline', repo: 'lucasmarkes/hairline' }
};
const LIBRARY = path.join(INSTRUCTIONS, 'library');
// A skill may come with files of its own: the reference pages, examples and code its instructions name. They sit in a
// folder named after the skill, beside its page, exactly as their project ships them. Only text files are kept.
const SKILL_FILE_TYPES = /\.(md|txt|js|mjs|cjs|ts|tsx|jsx|json|html|css|svg|py|sh|ya?ml|csv)$/i;
const MAX_SKILL_FILE_CHARS = 120000;
const skillFilesIn = (folder, base = '') => (fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.isDirectory()) return skillFilesIn(path.join(folder, entry.name), `${base}${entry.name}/`);
    return SKILL_FILE_TYPES.test(entry.name) ? [{ path: `${base}${entry.name}`, bytes: fs.statSync(path.join(folder, entry.name)).size }] : [];
}) : []);
// The text of one of a skill's files, or null when the skill has no such file. Only a path from the skill's own list
// is ever read, so nothing outside its folder can be reached.
export const skillFileText = (skill, wanted) => {
    const asked = String(wanted ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    const file = (skill?.files || []).find((one) => one.path === asked) || (skill?.files || []).find((one) => one.path.toLowerCase() === asked.toLowerCase());
    return file ? fs.readFileSync(path.join(skill.folder, file.path), 'utf8').replace(/\r\n/g, '\n').slice(0, MAX_SKILL_FILE_CHARS) : null;
};
const LIBRARY_SKILLS = Object.keys(SKILL_SOURCES).filter((source) => fs.existsSync(path.join(LIBRARY, source))).flatMap((source) => fs.readdirSync(path.join(LIBRARY, source)).filter((file) => file.endsWith('.md')).sort().map((file) => {
    const text = fs.readFileSync(path.join(LIBRARY, source, file), 'utf8').replace(/\r\n/g, '\n');
    const head = text.match(/^---\n([\s\S]*?)\n---\n/);
    const facts = Object.fromEntries((head?.[1] || '').split('\n').map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
    const needs = (facts.needs || '').split(',').filter(Boolean);
    const name = facts.name || file.slice(0, -3);
    return {
        id: file.slice(0, -3),
        name,
        description: facts.description || '',
        default: false,
        order: 100,
        credit: `${SKILL_SOURCES[source].repo} (${facts.licence})`,
        source,
        needs,
        folder: path.join(LIBRARY, source, file.slice(0, -3)),
        files: skillFilesIn(path.join(LIBRARY, source, file.slice(0, -3))),
        text: `SKILL: ${name}\n\n${text.slice(head?.[0].length || 0).trim()}`,
        remember: ''
    };
}));
export const SKILLS = [...OWN_SKILLS, ...LIBRARY_SKILLS];
// A skill is one to eight thousand tokens of instructions, so a chat holds only a few at once.
export const MAX_CHAT_SKILLS = 8;
// Short skills that need no commands or files and work as a conversation, so a small model can follow them.
export const SUGGESTED_SKILLS = ['engineering-grilling', 'dex-brainstorming', 'engineering-to-questionnaire', 'engineering-writing-shape', 'dex-decision-log', 'dex-weekly-reflection', 'dex-delegate-check'];

// The skills a person added by address are kept with their account. They are read once and remembered for a minute,
// so building a chat's instructions does not wait on the database.
export const MAX_OWN_SKILLS = 50;
const MAX_SKILL_BYTES = 120 * 1024;
const ownSkillCache = new Map();
const skillNeeds = (body) => [
    /\b(python3?|pip|npx|npm|node|uv|docker|brew)\s+[\w./-]|scripts\/[\w.-]+|```(bash|sh|shell|zsh)\n/i.test(body) && 'commands',
    /\b(references?|resources?|assets|templates?|examples?|rules|docs)\/[\w./-]+\.\w+|\]\((?!https?:|#)[^)]+\.(md|txt|json|ya?ml|py|sh|js|ts)\)/i.test(body) && 'files'
].filter(Boolean);
const ownSkill = (doc) => {
    const needs = skillNeeds(doc.text);
    return {
        id: `mine-${doc.id}`, name: doc.name, description: doc.description || '', default: false, order: 200, credit: doc.address, source: 'mine', needs,
        text: `SKILL: ${doc.name}\n\n${doc.text}`, remember: ''
    };
};
const ownSkillsOf = async (userId) => {
    const key = String(userId);
    const kept = ownSkillCache.get(key);
    if (kept && Date.now() - kept.at < 60000) return kept.skills;
    const skills = (await Skill.find({ service: SERVICE, owner: userId }).sort({ name: 1 })).map(ownSkill);
    if (ownSkillCache.size >= 2000) ownSkillCache.delete(ownSkillCache.keys().next().value);
    ownSkillCache.set(key, { at: Date.now(), skills });
    return skills;
};
const skillsFor = (ownerId) => [...SKILLS, ...(ownSkillCache.get(String(ownerId))?.skills || [])];
const skillsOf = (chat) => skillsFor(chat.owner).filter((skill) => (Array.isArray(chat.skills) ? chat.skills.includes(skill.id) : skill.default));
// A model that can use tools is sent only the name and description of each skill its chat has on, inside one function,
// and opens a skill with that function when a request fits it. A skill opened earlier in the chat is sent in full from
// then on, and so is Mollama's own. A model that cannot use tools is sent every skill in full.
const SKILL_STEP = 'Skill';
const sortSkills = (chat, listing) => {
    const active = skillsOf(chat);
    if (!listing) return { full: active, listed: [] };
    const opened = new Set(chat.messages.flatMap((message) => (message.steps || []).filter((step) => step.tool === SKILL_STEP && !step.failed).map((step) => step.input)));
    const full = active.filter((skill) => skill.source === 'mollama' || opened.has(skill.name));
    return { full, listed: active.filter((skill) => !full.includes(skill)) };
};
const openSkillTool = (listed) => {
    const find = (input) => {
        const wanted = String(input?.skill ?? '').trim().toLowerCase();
        return listed.find((skill) => skill.name.toLowerCase() === wanted || skill.id === wanted);
    };
    return {
        fn: 'open_skill',
        label: SKILL_STEP,
        changes: false,
        shown: (input) => find(input)?.name || clip(String(input?.skill ?? ''), 80),
        knows: (name) => Boolean(find({ skill: String(name).replace(/[_-]+/g, ' ') })),
        slip: (name) => ({ skill: String(name).replace(/[_-]+/g, ' ') }),
        definition: {
            type: 'function',
            function: {
                name: 'open_skill',
                description: `Open one of this chat's skills and get its full instructions. Open a skill before answering when the request matches its description.\n${listed.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`,
                parameters: { type: 'object', properties: { skill: { type: 'string', enum: listed.map((skill) => skill.name), description: 'The name of the skill to open' } }, required: ['skill'] }
            }
        },
        run: async (input) => {
            const skill = find(input);
            return skill ? { content: skill.text } : { content: `There is no skill by that name in this chat. The skills are: ${listed.map((one) => one.name).join(', ')}.`, failed: 'failed' };
        }
    };
};
// The files of the skills a chat has on are read one at a time, when the skill's instructions send the model to one.
// What the person is told a model is doing while it writes a call to a tool and while that tool runs.
const DOING = {
    web_search: 'Searching the web…',
    web_fetch: 'Reading a web page…',
    read_web_page: 'Reading a web page…',
    open_skill: 'Opening a skill…',
    open_skill_file: "Reading one of a skill's files…",
    open_component: 'Reading how to draw a component…',
    find_skill: 'Looking in the skill library…',
    calculator: 'Working out a sum…',
    date_time: 'Checking the date and time…'
};
const doingOf = (name, tools = []) => {
    const tool = tools.find((one) => one.fn === name);
    return tool?.doing || DOING[name] || `Using ${tool?.label || name}…`;
};
const SKILL_FILE_STEP = 'Skill file';
const SKILL_FILE_ROOM = 12000;
const skillFileTool = (withFiles) => {
    const find = (input) => {
        const wanted = String(input?.skill ?? '').trim().toLowerCase();
        return withFiles.find((skill) => skill.id === wanted || skill.name.toLowerCase() === wanted) || (withFiles.length === 1 ? withFiles[0] : null);
    };
    return {
        fn: 'open_skill_file',
        label: SKILL_FILE_STEP,
        changes: false,
        shown: (input) => `${clip(String(input?.file ?? ''), 80)} (${find(input)?.name || clip(String(input?.skill ?? ''), 60)})`,
        definition: {
            type: 'function',
            function: {
                name: 'open_skill_file',
                description: `Read one of the files that belong to a skill of this chat, such as a rules page, an example or the code its instructions name. Read a file when the skill's instructions tell you to.\n${withFiles.map((skill) => `- ${skill.id}: ${skill.files.map((file) => file.path).join(', ')}`).join('\n')}`,
                parameters: { type: 'object', properties: { skill: { type: 'string', enum: withFiles.map((skill) => skill.id), description: 'The skill the file belongs to' }, file: { type: 'string', description: 'The path of the file, as listed' }, until: { type: 'string', description: 'Optional. Read only the start of the file, up to the first line that contains this text. Use it when the instructions say to read only the top of a file.' } }, required: ['skill', 'file'] }
            }
        },
        run: async (input) => {
            const skill = find(input);
            const whole = skill ? skillFileText(skill, input?.file) : null;
            const stop = typeof input?.until === 'string' && input.until.trim() ? input.until.trim() : null;
            const lines = whole === null ? [] : whole.split('\n');
            const end = stop ? lines.findIndex((line) => line.includes(stop)) : -1;
            const text = whole !== null && end > 0 ? lines.slice(0, end).join('\n') : whole;
            if (text !== null) return { content: text };
            return { content: skill ? `That skill has no file by that name. Its files are: ${skill.files.map((file) => file.path).join(', ')}.` : `There is no skill by that name with files in this chat. The skills with files are: ${withFiles.map((one) => one.id).join(', ')}.`, failed: 'failed' };
        }
    };
};
// What a skill's instructions ask an agent to do with a command, Mollama does itself where it can: one function for
// one command, offered while the skill is on, doing exactly what that command does and nothing more. No script of a
// skill is run on the server.
const SKILL_FUNCTIONS = {
    'hairline-hairline-create': [{
        name: 'hairline_build',
        label: 'Hairline build',
        doing: 'Building the figure…',
        description: 'Does what `node build.mjs <name>.js` does in the Hairline skill, without Node: puts your figure on the bench (bench.html with kernel.js and the figure in their two slots, nothing else changed) and shows the finished page to the user in the chat. Give the whole figure file. Use this instead of asking the user to run anything. There is no browser for you to look with here, so look.mjs cannot be run: say plainly that the look was not done.',
        parameters: { type: 'object', properties: { code: { type: 'string', description: 'The whole figure file as you would save it in <name>.js, ending with its hairline({ ... }) call' } }, required: ['code'] },
        run: (input, { show }) => {
            const code = String(input?.code ?? '').replace(/\r\n/g, '\n').trim();
            const call = [...code.matchAll(/\bhairline\s*\(\s*\{/g)].at(-1);
            if (!call) return { content: 'Nothing was built. A figure file ends with hairline({ name, means, rules, range, tour, mount }).', failed: 'failed' };
            if (code.includes('```')) return { content: 'Nothing was built. The figure must not contain three backticks in a row.', failed: 'failed' };
            const name = /\bname:\s*["'`]([a-z][a-z0-9-]*)["'`]/.exec(code.slice(call.index))?.[1] || 'figure';
            show(['```component', `<Frame template="hairline-hairline-create/bench.html" height="640px" title="Hairline ${name}" palette="ground:background, ink:text, muted:text 65%, line:border, hairline-plate:background, hairline-hi:text, hairline-edge:text 55%, hairline-mid:text 32%, hairline-lo:border">`, '<Part name="KERNEL" file="hairline-hairline-create/kernel.js" />', '<Part name="FIGURE">', code, '</Part>', '</Frame>', '```'].join('\n'));
            return { content: `Built hairline-${name}.html and showed it to the user in the chat. You cannot see the page from here.` };
        }
    }]
};
const skillFunctionsFor = (chat) => skillsOf(chat).flatMap((skill) => (SKILL_FUNCTIONS[skill.id] || []).map((entry) => ({
    fn: entry.name,
    label: entry.label,
    doing: entry.doing,
    changes: false,
    shown: () => skill.name,
    definition: { type: 'function', function: { name: entry.name, description: entry.description, parameters: entry.parameters } },
    run: async (input, context) => entry.run(input, context)
})));
// The level above a chat's own skills is the whole library, searched by a few words. A model cannot turn a skill on:
// it names the one that would help, and the person turns it on.
const LIBRARY_STEP = 'Skill library';
// Whole words are matched, so "app" does not find "Apple"; a longer word also finds its other endings ("planning", "plans").
const FILLER_WORDS = new Set(['the', 'and', 'for', 'with', 'new', 'how', 'can', 'you', 'your', 'help', 'make', 'need', 'want', 'about', 'that', 'this']);
const wordIn = (text, word) => {
    const stem = word.replace(/(ing|ed|es|s)$/, '');
    return new RegExp(stem.length < 5 ? `\\b${stem}(s|es)?\\b` : `\\b${stem}`, 'i').test(text);
};
export const rankSkills = (skills, query) => {
    const words = (String(query ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((word) => !FILLER_WORDS.has(word));
    return skills
        .map((skill) => ({ skill, score: words.reduce((sum, word) => sum + (wordIn(skill.name, word) ? 4 : 0) + (wordIn(skill.description, word) ? 1 : 0), 0) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((hit) => hit.skill);
};
const findSkillTool = (others) => ({
    fn: 'find_skill',
    label: LIBRARY_STEP,
    changes: false,
    shown: (input) => clip(String(input?.query ?? ''), 80),
    definition: {
        type: 'function',
        function: {
            name: 'find_skill',
            description: `Search the library of ${others.length} skills for one that is not turned on in this chat. A skill is a set of expert instructions for one kind of work, such as writing a cold email, reviewing a contract or planning a launch. Returns matching skills by name and description. You cannot turn a skill on yourself: when one would help, tell the user its name and that they can turn it on under Skills.`,
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'A few words for the kind of work' } }, required: ['query'] }
        }
    },
    run: async (input) => {
        const found = rankSkills(others, input?.query);
        if (found.length === 0) return { content: 'No skill in the library matches. Answer without one.' };
        const lines = found.map((skill) => `- ${skill.name} (${SKILL_SOURCES[skill.source]?.name || skill.source}): ${skill.description}`);
        return { content: ['These skills are not turned on in this chat. Tell the user by name which one would help and that they can turn it on under Skills, then answer as well as you can without it.', ...lines].join('\n') };
    }
});
// A skill may end with a reminder, which is put last so it is the last thing the model reads.
const closingOf = (chat) => {
    const reminders = skillsOf(chat).map((skill) => skill.remember).filter(Boolean);
    return reminders.length > 0 ? ['REMEMBER', ...reminders].join('\n') : '';
};

// Each component the chat can draw has its own page in instructions/components: every attribute, every value and what
// each does on screen. The Components skill is only the index. A model that can use tools opens the page of the
// component it is about to write, and the page is gone again once that reply is written: no page is ever sent ahead of
// need, and none is carried into the next message. A model that cannot use tools has the index alone.
export const COMPONENT_PAGES = fs.readdirSync(path.join(INSTRUCTIONS, 'components')).filter((file) => file.endsWith('.md')).sort().map((file) => ({
    name: file.slice(0, -3),
    text: fs.readFileSync(path.join(INSTRUCTIONS, 'components', file), 'utf8').replace(/\r\n/g, '\n').trim()
}));
const COMPONENT_STEP = 'Component';
// Room kept for the pages of the few components one reply draws.
const COMPONENT_ROOM = 5000;
const namesIn = (text) => String(text ?? '').split(/[\s,]+/).filter(Boolean);
const drawsComponents = (chat) => skillsOf(chat).some((skill) => skill.id === 'components');
const openComponentTool = () => {
    const find = (input) => namesIn(input?.component).map((name) => COMPONENT_PAGES.find((page) => page.name.toLowerCase() === name.toLowerCase()));
    return {
        fn: 'open_component',
        label: COMPONENT_STEP,
        changes: false,
        shown: (input) => find(input).filter(Boolean).map((page) => page.name).join(', ') || clip(String(input?.component ?? ''), 80),
        knows: (name) => COMPONENT_PAGES.some((page) => page.name.toLowerCase() === String(name).toLowerCase()),
        slip: (name) => ({ component: name }),
        definition: {
            type: 'function',
            function: {
                name: 'open_component',
                description: "Get the page for a component: every attribute it takes, every value, and what each does on screen. Open a component's page before you write that component.",
                parameters: { type: 'object', properties: { component: { type: 'string', description: 'The name of the component, or several names separated by commas, such as Card, Badge' } }, required: ['component'] }
            }
        },
        run: async (input) => {
            const found = find(input);
            if (found.length === 0 || found.some((page) => !page)) return { content: `There is no component by that name. The components are: ${COMPONENT_PAGES.map((page) => page.name).join(', ')}.`, failed: 'failed' };
            return { content: found.map((page) => page.text).join('\n\n') };
        }
    };
};

const presentSkill = ({ id, name, description, default: on, credit, source, needs, text, files = [] }) => ({ id, name, description, default: on, credit, source, needs, tokens: estimateTokens(text), suggested: SUGGESTED_SKILLS.includes(id), files: files.map((file) => file.path) });
export const listSkills = asyncHandler(async (req, res) => {
    const servers = await ToolServer.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 });
    const all = [...SKILLS, ...await ownSkillsOf(req.user.id)];
    res.status(200).json({
        success: true,
        webSearch: webSearchReady(),
        skills: all.map(presentSkill),
        sources: Object.entries(SKILL_SOURCES).map(([id, source]) => ({ id, name: source.name, repo: source.repo, count: all.filter((skill) => skill.source === id).length })).filter((source) => source.count > 0),
        maxSkills: MAX_CHAT_SKILLS,
        maxOwnSkills: MAX_OWN_SKILLS,
        tools: [
            ...BUILTIN_TOOLS.map(({ id, name, description }) => ({ id, name, description, kind: 'builtin', ready: true, count: 1 })),
            ...servers.map((server) => ({ id: server.id, name: server.name, description: null, kind: server.kind, ready: server.health === 'healthy', state: TOOL_HEALTH[server.health].label, count: server.tools.length }))
        ]
    });
});

// The whole text of one skill, for reading before it is turned on.
export const readSkill = asyncHandler(async (req, res) => {
    const skill = [...SKILLS, ...await ownSkillsOf(req.user.id)].find((one) => one.id === req.params.id);
    if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
    return res.status(200).json({ success: true, skill: { ...presentSkill(skill), text: skill.text } });
});

// One of a skill's own files, for the page that shows what a model built with them.
export const readSkillFile = asyncHandler(async (req, res) => {
    const skill = SKILLS.find((one) => one.id === req.params.id);
    const text = skill ? skillFileText(skill, req.query.path) : null;
    if (text === null) return res.status(404).json({ success: false, message: 'This skill has no such file.' });
    return res.status(200).json({ success: true, skill: skill.id, path: String(req.query.path), text });
});

// A skill's own header: its name and description, including a description folded over several lines.
const skillHeader = (text) => {
    const head = text.match(/^---\n([\s\S]*?)\n---\n?/);
    const lines = (head?.[1] || '').split('\n');
    const facts = {};
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^([\w-]+):\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (/^[>|][-+]?$/.test(value) || value === '') {
            const more = [];
            while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) more.push(lines[++index].trim());
            value = more.join(' ');
        }
        facts[match[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ').trim();
    }
    return { facts, body: text.slice(head?.[0].length || 0).trim() };
};
// Where a skill's file is read from: a GitHub page address is turned into the address of the file itself.
export const skillFileAddress = (address) => {
    const url = new URL(address);
    if (url.hostname !== 'github.com') return url.href;
    const [owner, repo, kind, branch, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return url.href;
    const file = rest.join('/');
    const path = kind === 'blob' ? file : [file, 'SKILL.md'].filter(Boolean).join('/');
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${['blob', 'tree'].includes(kind) && branch ? branch : 'HEAD'}/${path}`;
};

// Adds a skill from its address, or reads it again when the person already has it.
export const addSkill = asyncHandler(async (req, res) => {
    const address = req.body.address;
    const existing = await Skill.findOne({ service: SERVICE, owner: req.user.id, address });
    if (!existing && await Skill.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_OWN_SKILLS) {
        return res.status(422).json({ success: false, message: `You have ${MAX_OWN_SKILLS} skills of your own, which is the limit.`, action: 'Remove one you no longer use.' });
    }
    let text = '';
    try {
        const { stream } = await fetchRemote(skillFileAddress(address));
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > MAX_SKILL_BYTES) {
                stream.destroy?.();
                return res.status(422).json({ success: false, message: 'That skill is larger than 120 KB, which is more than a chat can hold.', action: 'Add a shorter skill.' });
            }
            chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    } catch (error) {
        return sendOllamaError(res, error);
    }
    const { facts, body } = skillHeader(text);
    if (!body || /^\s*<(!doctype|html)/i.test(text) || text.includes('\u0000')) {
        return res.status(422).json({ success: false, message: 'That address is not a skill file.', action: 'Paste the address of a SKILL.md file, or of the folder on GitHub that holds one.' });
    }
    const folder = new URL(skillFileAddress(address)).pathname.split('/').filter(Boolean).slice(-2, -1)[0] || 'Skill';
    const fields = {
        name: String(facts.name || folder).replace(/[-_]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase()).slice(0, 120),
        description: String(facts.description || body.split('\n').find((line) => line.trim() && !line.startsWith('#')) || '').slice(0, 400),
        text: body,
        checkedAt: new Date()
    };
    const skill = existing ? Object.assign(existing, fields) : new Skill({ owner: req.user.id, address, ...fields });
    await skill.save();
    ownSkillCache.delete(String(req.user.id));
    logger.info('[Skills] Skill added', { skillId: skill.id, userId: req.user.id });
    return res.status(existing ? 200 : 201).json({ success: true, skill: presentSkill(ownSkill(skill)) });
});

export const removeSkill = asyncHandler(async (req, res) => {
    const id = req.params.id.replace(/^mine-/, '');
    const skill = mongoose.isValidObjectId(id) ? await Skill.findOneAndDelete({ _id: id, service: SERVICE, owner: req.user.id }) : null;
    if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
    ownSkillCache.delete(String(req.user.id));
    return res.status(200).json({ success: true, message: 'Skill removed.' });
});

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

// Models do not know the date; without it they guess a year from their training. It changes once a day, so the
// prompt a computer has already read stays good for the rest of that day.
export const todayLine = () => `Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} (UTC).`;

const buildMessages = (chat, listing = false) => {
    const out = [];
    const active = sortSkills(chat, listing).full;
    const system = [...active.map((skill) => skill.text), systemText(chat), chat.summary && `Summary of the earlier conversation:\n${chat.summary}`, todayLine(), closingOf(chat)].filter(Boolean).join('\n\n');
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
    const used = Math.max(promptTokens(buildMessages(chat, facts.capabilities.includes('tools'))), measured) + pending;
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
    device: chat.device ? String(chat.device) : null,
    system: systemText(chat),
    systemSource: chat.systemSource,
    instructions: instructionsOf(chat),
    skills: skillsOf(chat).map((skill) => skill.id),
    tools: chat.tools || [],
    webSearch: chat.webSearch !== false,
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
    await ownSkillsOf(req.user.id);
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
    for (const key of ['title', 'model', 'system', 'options', 'webSearch']) {
        if (key in body) chat[key] = body[key];
    }
    if ('skills' in body) chat.skills = body.skills ? skillsFor(chat.owner).filter((skill) => body.skills.includes(skill.id)).map((skill) => skill.id).slice(0, MAX_CHAT_SKILLS) : undefined;
    if ('tools' in body) {
        chat.tools = body.tools?.length ? [...new Set(body.tools)] : undefined;
        chat.allowedTools = undefined;
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

// A chat runs on the computer it was given; without one it follows the request, and remembers a linked computer.
const chatTarget = async (req, chat) => {
    const device = chat.device ? await allowedDevice(req, chat.device) : null;
    if (!device && chat.device && await Provider.exists({ _id: chat.device, service: SERVICE, owner: req.user.id })) return { kind: 'cloud', id: String(chat.device) };
    return device ? targetOf(device) : currentTarget();
};

// False when the request names a computer this person may not use.
const setChatDevice = async (req, chat) => {
    if (!('device' in (req.body || {}))) return true;
    const device = req.body.device ? await allowedDevice(req, req.body.device) : null;
    const online = req.body.device && !device ? await Provider.exists({ _id: req.body.device, service: SERVICE, owner: req.user.id }) : null;
    if (req.body.device && !device && !online) return false;
    chat.device = device ? device._id : online ? online._id : null;
    return true;
};

export const createChat = asyncHandler(async (req, res) => {
    await ownSkillsOf(req.user.id);
    const chat = new Chat({ owner: req.user.id });
    applyChatFields(chat, req.body || {});
    if (!(await setChatDevice(req, chat))) return res.status(404).json({ success: false, message: 'Device not found' });
    deviceScope.enterWith(await chatTarget(req, chat));
    await chat.save();
    res.status(201).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const getChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    deviceScope.enterWith(await chatTarget(req, chat));
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const updateChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    applyChatFields(chat, req.body);
    if (!(await setChatDevice(req, chat))) return res.status(404).json({ success: false, message: 'Device not found' });
    deviceScope.enterWith(await chatTarget(req, chat));
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
        if (!(await ollama.status()).available) throw new OllamaError(targetPaused() ? 'DEVICE_PAUSED' : 'OLLAMA_DOWN');
        if (!chat.model) chat.model = await chooseModel(ollama, userId);
        facts = await modelFacts(ollama, chat.model);

        prompt = buildMessages(chat, facts.capabilities.includes('tools'));
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

    // Sent "live", the request only answers that the reply has started; its pieces go out on the person's live
    // connection, so every app they have open follows the same reply.
    if (res && body.live) {
        res.status(202).json({ success: true, started: true });
        res = null;
    }
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
    // Ends a request the model has not started answering, which is the whole time a model is loading into memory.
    const halt = new AbortController();
    const write = (event) => {
        const last = live.events[live.events.length - 1];
        if ((event.type === 'token' || event.type === 'thinking') && last?.type === event.type) last.text += event.text;
        else live.events.push({ ...event });
        const line = `${JSON.stringify(event)}\n`;
        for (const listener of live.listeners) {
            if (!listener.writableEnded) listener.write(line);
        }
        live.seq += 1;
        getNotificationService().sendToUser(String(userId), { type: 'chat:reply', data: { chatId: chat.id, seq: live.seq, event } });
    };
    const reportPlace = () => {
        if (job?.state === 'waiting') write({ type: 'queued', ahead: job.ahead() });
    };
    live.stop = () => {
        gone = true;
        job?.cancel();
        halt.abort();
        stream?.abort?.();
        onStop();
    };

    write({ type: 'accepted', chat: { id: chat.id, title: chat.title, model: chat.model }, messageCount: chat.messages.length });

    const reply = { content: '', thinking: '', stats: {}, errorCode: null, stopped: false, steps: [], unverified: [] };
    const lane = currentLane();
    const run = async () => {
        if (gone) return;
        const loaded = await ollama.running().then((list) => list.models.some((entry) => entry.name === chat.model)).catch(() => true);
        write({ type: 'start', sharing: queue.runningIn(lane) - 1, loaded });
        // Web search is two tools, handed to a model that can use tools when the chat has search on. The model decides
        // when to use them; nothing of Mollama's own is added to tell it how.
        const searching = webSearchReady() && chat.webSearch !== false && facts.capabilities.includes('tools');
        const messages = [...prompt];
        // With web search on, its own page reader does the built-in one's job, so only one of the two is offered.
        const { listed } = sortSkills(chat, facts.capabilities.includes('tools'));
        const on = new Set(skillsOf(chat).map((skill) => skill.id));
        const others = skillsFor(chat.owner).filter((skill) => !on.has(skill.id));
        const draws = drawsComponents(chat);
        const withFiles = facts.capabilities.includes('tools') ? skillsOf(chat).filter((skill) => (skill.files || []).length > 0) : [];
        const chatTools = facts.capabilities.includes('tools') ? [...(draws ? [openComponentTool()] : []), ...(withFiles.length > 0 ? [skillFileTool(withFiles)] : []), ...skillFunctionsFor(chat), ...(listed.length > 0 ? [openSkillTool(listed)] : []), ...(others.length > 0 ? [findSkillTool(others)] : []), ...(await toolsForChat(chat, userId)).filter((tool) => !(searching && tool.fn === 'read_web_page'))] : [];
        const capacity = capacityFor(chat, facts);
        const sizeFor = (list, extra = 0) => {
            const fitted = CONTEXT_STEPS.find((step) => step >= promptTokens(list) + REPLY_RESERVE + extra) || capacity;
            return Number(chat.options?.num_ctx) > 0 ? capacity : Math.min(capacity, searching ? Math.max(fitted, SEARCH_CONTEXT) : fitted);
        };
        // Room is kept for the largest skill that may be opened, so opening one never overflows what the model can read.
        // A function may put something into the reply itself, such as a page it built for the person to see.
        const show = (block) => {
            const text = `${reply.content && !/\n\n$/.test(reply.content) ? '\n\n' : ''}${block}\n\n`;
            reply.content += text;
            write({ type: 'token', text });
        };
        const numCtx = sizeFor(messages, listed.reduce((most, skill) => Math.max(most, estimateTokens(skill.text)), Math.max(draws && facts.capabilities.includes('tools') ? COMPONENT_ROOM : 0, withFiles.length > 0 ? SKILL_FILE_ROOM : 0)));
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
                if ((searching || chatTools.length > 0) && round < MAX_TOOL_ROUNDS) request.tools = [...(searching ? SEARCH_TOOLS : []), ...chatTools.map((tool) => tool.definition)];

                const calls = [];
                let said = '';
                stream = await ollama.chat(request, halt.signal);
                if (gone) stream.abort?.();
                for await (const part of stream) {
                    // Nothing that arrives after Stop is kept or shown, even if the service had already sent it.
                    if (gone) break;
                    if (part.message?.tool_start) write({ type: 'note', text: doingOf(String(part.message.tool_start), chatTools) });
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
                        // The first request of a reply holds the conversation alone. Later ones also hold what its tools
                        // returned, which is gone once the reply is written, so they are not what the chat is measured by.
                        promptEvalCount = promptEvalCount || part.prompt_eval_count || null;
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
                    // A small model sometimes calls a skill by its own name instead of through the function that opens it.
                    const real = chatTools.find((tool) => tool.fn === name);
                    const opener = real || SEARCH_TOOLS.some((tool) => tool.function.name === name) ? null : chatTools.find((tool) => tool.knows?.(name));
                    const mine = real || opener;
                    const given = opener ? opener.slip(name) : toolArguments(call.function?.arguments);
                    const input = mine?.shown ? mine.shown(given) : mine ? clip(JSON.stringify(given), 500) : toolInput(name, call.function?.arguments);
                    const step = { tool: mine ? mine.label : name, input, failed: null };
                    reply.steps.push(step);
                    write({ type: 'note', text: doingOf(mine ? mine.fn : name, chatTools) });
                    write({ type: 'tool', tool: step.tool, input });
                    // Stop does not wait for a tool that is still running: a search, a page being read, a question to the person.
                    const outcome = await Promise.race([
                        mine ? runChatTool(mine, given, { chat, userId, write, stopped: () => gone, show }) : runSearchTool(name, input),
                        stopSignal.then(() => ({ content: 'The reply was stopped.', failed: 'refused' }))
                    ]);
                    if (outcome.failed) {
                        step.failed = outcome.failed;
                        write({ type: 'toolFailed', failed: outcome.failed });
                    }
                    messages.push({ role: 'tool', tool_name: name, content: outcome.content });
                    if (gone) break;
                }
                // The tools are done; the model is thinking again.
                write({ type: 'note', text: '' });
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
    };

    try {
        job = queue.add({ userId, priority: 'interactive', run, lane });
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
    const live = { events: [], listeners: new Set(), stop: null, stopped: false, seq: 0 };
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
            getNotificationService().sendToUser(String(userId), { type: 'chat:reply', data: { chatId: id, seq: turn.live.seq + 1, event: { type: 'end' } } });
            getNotificationService().sendToUser(String(userId), { type: 'chat:changed', data: { id, removed: false } });
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
    const target = await chatTarget(req, chat);
    deviceScope.enterWith(target);
    if (!chat.device && target.kind === 'companion') chat.device = target.id;
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

// Where a reply being written has got to, worked out from what it has sent so far.
const replyProgress = (live) => {
    const events = live?.events || [];
    const words = events.filter((event) => event.type === 'token').map((event) => event.text).join('').split(/\s+/).filter(Boolean).length;
    if (words > 0) return { phase: 'writing', words };
    const started = events.some((event) => event.type === 'start');
    const queued = [...events].reverse().find((event) => event.type === 'queued');
    if (!started && queued?.ahead > 0) return { phase: 'waiting', words: 0, ahead: queued.ahead };
    if (events.some((event) => event.type === 'thinking')) return { phase: 'thinking', words: 0 };
    const tool = [...events].reverse().find((event) => event.type === 'tool');
    if (tool) return { phase: tool.tool === 'web_fetch' ? 'reading' : 'searching', words: 0 };
    return { phase: 'starting', words: 0 };
};

export const getActivity = asyncHandler(async (req, res) => {
    const ids = [...liveReplies.keys()];
    const chats = ids.length > 0
        ? await Chat.find({ _id: { $in: ids }, service: SERVICE, owner: req.user.id }).select('title model')
        : [];
    const jobs = (await downloads.list()).filter((job) => ['queued', 'downloading'].includes(job.status)
        || (['completed', 'failed'].includes(job.status) && job.finishedAt && Date.now() - new Date(job.finishedAt).getTime() < RECENT_DOWNLOAD_MS));
    res.status(200).json({
        success: true,
        replies: chats.map((chat) => ({ chatId: chat.id, title: chat.title, model: chat.model, waiting: (queuedTurns.get(chat.id) || []).length, ...replyProgress(liveReplies.get(chat.id)) })),
        downloads: jobs.map((job) => ({ id: job.id, model: job.model, status: job.status, percent: job.percent })),
        permissions: { manage: canManage(req) }
    });
});

// What a reply in progress has sent so far, for an app that joins late or missed a piece on the live connection.
export const liveReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const live = liveReplies.get(chat.id);
    res.status(200).json({ success: true, replying: Boolean(live), seq: live?.seq || 0, events: live?.events || [] });
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
        if (!(await ollama.status()).available) throw new OllamaError(targetPaused() ? 'DEVICE_PAUSED' : 'OLLAMA_DOWN');
        const model = req.body?.name || await chooseModel(ollama, req.user.id);
        const loaded = (await ollama.running()).models.some((entry) => entry.name === model);
        const busy = queue.busyIn(currentLane());
        const loading = !loaded && !busy && settings.keepAliveMinutes > 0;
        if (loading) {
            const facts = await modelFacts(ollama, model);
            const numCtx = Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT, webSearchReady() ? SEARCH_CONTEXT : CONTEXT_STEPS[0]);
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
    deviceScope.enterWith(await chatTarget(req, chat));
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
            lane: currentLane(),
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
        device: chat.device,
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

const MAX_TOOL_SERVERS = 20;

const presentToolServer = (server) => ({
    id: server.id,
    name: server.name,
    kind: server.kind,
    address: server.address,
    device: server.device ? String(server.device) : null,
    signIn: server.signIn,
    tools: server.tools.map(({ name, title, description, readOnly }) => ({ name, title, description, readOnly })),
    health: {
        state: server.health,
        label: TOOL_HEALTH[server.health].label,
        needs: TOOL_HEALTH[server.health].needs,
        detail: server.healthDetail,
        checkedAt: server.checkedAt
    }
});

const toolCallbackUrl = (req) => `${process.env.NODE_ENV === 'production' ? 'https' : req.protocol}://${req.get('host')}/api/v1/tools/callback`;

// Finds out whether a tool server can be used right now, and records what it offers. The server comes with its sealed part.
const checkToolServer = async (server) => {
    const before = server.health;
    let state;
    let detail = null;
    let tools = null;
    if (server.kind === 'local') {
        if (!deviceGateway.isOnline(server.device)) state = 'offline';
        else {
            try {
                const answer = await deviceGateway.tools(server.device, { action: 'check', localId: server.localId });
                state = ['healthy', 'stopped', 'missing', 'empty'].includes(answer?.state) ? answer.state : 'stopped';
                detail = answer?.detail ? String(answer.detail).slice(0, 300) : null;
                if (state === 'healthy') tools = (Array.isArray(answer.tools) ? answer.tools : []).slice(0, 200);
            } catch (error) {
                state = error instanceof OllamaError ? 'offline' : 'outdated';
            }
        }
    } else {
        const kept = unseal(server.sealed) || {};
        const keeper = kept.key ? null : accountKeeper(kept, kept.redirect);
        try {
            tools = await withToolServer({ address: server.address, key: kept.key, keeper }, readTools);
            state = tools.length > 0 ? 'healthy' : 'empty';
        } catch (error) {
            state = toolFault(error, Boolean(kept.key));
        }
        if (keeper) server.sealed = seal(kept);
        if (keeper && (kept.tokens || state === 'signin')) server.signIn = 'account';
    }
    server.health = state;
    server.healthDetail = detail;
    server.checkedAt = new Date();
    if (tools) server.tools = tools;
    await server.save();
    if (before !== state) getNotificationService().sendToUser(String(server.owner), { type: 'tools:changed', data: { id: server.id, health: state } });
    return server;
};

const findToolServer = async (req, res) => {
    const server = await ToolServer.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id }).select('+sealed');
    if (!server) res.status(404).json({ success: false, message: 'Tool server not found' });
    return server;
};

export const listToolCatalogue = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, apps: TOOL_CATALOGUE.map((entry) => ({ ...entry, keyNeeded: toolKeyNeeded(entry) })), localApps: TOOL_LOCAL_CATALOGUE });
});

export const listToolServers = asyncHandler(async (req, res) => {
    const servers = await ToolServer.find({ service: SERVICE, owner: req.user.id }).sort({ kind: -1, name: 1 });
    res.status(200).json({ success: true, servers: servers.map(presentToolServer) });
});

export const addToolServer = asyncHandler(async (req, res) => {
    if (await ToolServer.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_TOOL_SERVERS) {
        return res.status(422).json({ success: false, message: 'You have 20 tool servers, which is the limit.', action: 'Remove one you no longer use.' });
    }
    const { kind, name, address, key, device, localId } = req.body;
    const fields = { owner: req.user.id, name, kind };
    if (kind === 'local') {
        const computer = await Device.findOne({ _id: device, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
        if (!computer) return res.status(404).json({ success: false, message: 'That computer is not one of yours.', action: 'Add it from the Mollama desktop app on that computer.' });
        if (await ToolServer.exists({ service: SERVICE, owner: req.user.id, device, localId })) return res.status(409).json({ success: false, message: 'That tool server is already added.' });
        Object.assign(fields, { device, localId });
    } else {
        if (!key && toolKeyNeeded(listedTool(address))) {
            return res.status(422).json({ success: false, message: 'This app needs a key here.', action: 'Follow the steps shown to get a free key, then add it.' });
        }
        Object.assign(fields, { address, signIn: key ? 'key' : 'none', sealed: seal(key ? { key } : { redirect: toolCallbackUrl(req) }) });
    }
    const server = await checkToolServer(await ToolServer.create(fields));
    res.status(201).json({ success: true, server: presentToolServer(server) });
});

export const checkToolServerNow = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    res.status(200).json({ success: true, server: presentToolServer(await checkToolServer(server)) });
});

export const updateToolServer = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    if ('name' in req.body) server.name = req.body.name;
    if ('key' in req.body && server.kind === 'remote') {
        server.sealed = seal(req.body.key ? { key: req.body.key } : { redirect: toolCallbackUrl(req) });
        server.signIn = req.body.key ? 'key' : 'none';
        await checkToolServer(server);
    } else {
        await server.save();
    }
    res.status(200).json({ success: true, server: presentToolServer(server) });
});

export const removeToolServer = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    await server.deleteOne();
    res.status(200).json({ success: true, message: 'Tool server removed.' });
});

// Starts a sign-in to the app behind a remote tool server and answers with the app's own sign-in address.
export const startToolSignIn = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    if (server.kind !== 'remote') return res.status(422).json({ success: false, message: 'Only remote tool servers are signed in to.' });
    const kept = { redirect: toolCallbackUrl(req), state: crypto.randomBytes(24).toString('base64url') };
    const keeper = accountKeeper(kept, kept.redirect);
    try {
        await withToolServer({ address: server.address, keeper }, async () => null);
    } catch (error) {
        if (!(error instanceof ToolSignInError) || !/^https:\/\//.test(keeper.asked || '')) {
            return res.status(422).json({ success: false, message: 'This app did not offer a way to sign in.', action: 'If it gave you a key, add the key instead.' });
        }
        server.sealed = seal(kept);
        server.signInState = hashKey(kept.state);
        server.signIn = 'account';
        await server.save();
        return res.status(200).json({ success: true, url: keeper.asked });
    }
    res.status(200).json({ success: true, url: null, server: presentToolServer(await checkToolServer(server)) });
});

// Where the app sends the person back after signing in. There is no session here, so the state value finds the server.
export const finishToolServerSignIn = asyncHandler(async (req, res) => {
    const back = (result) => res.redirect(`${process.env.APP_URL}/tools?signin=${result}`);
    const state = String(req.query.state || '');
    const server = state ? await ToolServer.findOne({ service: SERVICE, signInState: hashKey(state) }).select('+sealed +signInState') : null;
    if (!server) return back('failed');
    const kept = unseal(server.sealed) || {};
    server.signInState = null;
    try {
        if (!req.query.code || kept.state !== state) throw new Error('refused');
        await finishToolSignIn(server.address, accountKeeper(kept, kept.redirect), new URLSearchParams({ code: String(req.query.code), state, ...(req.query.iss ? { iss: String(req.query.iss) } : {}) }));
    } catch {
        await server.save();
        return back('failed');
    }
    delete kept.state;
    delete kept.verifier;
    server.sealed = seal(kept);
    await checkToolServer(server);
    back(server.health === 'healthy' ? 'done' : 'failed');
});

const MAX_PROVIDERS = 20;
const presentProvider = (provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    modelCount: provider.models.length,
    models: provider.models.slice(0, 300).map((model) => model.name),
    health: { state: provider.health, label: PROVIDER_HEALTH[provider.health].label, needs: PROVIDER_HEALTH[provider.health].needs, checkedAt: provider.checkedAt }
});
// How a connected provider appears among the computers a chat can use.
function presentOnlineDevice(provider) {
    return {
        id: provider.id, name: `${provider.name} (online)`, kind: 'cloud', service: SERVICE, online: true, lastSeenAt: provider.checkedAt, hardware: null, detected: null,
        overrides: {}, paused: false, edited: false, ollama: { available: provider.health === 'healthy', version: null, modelCount: provider.models.length, chatCount: provider.models.length }
    };
}
const PROVIDER_FAULTS = { KEY_REFUSED: 'refused', OUT_OF_CREDIT: 'credit', PROVIDER_BUSY: 'busy' };

// Reads the provider's list of models with the person's key, which also proves the key works.
const checkProvider = async (provider) => {
    const entry = CLOUD_PROVIDERS.find((one) => one.id === provider.kind);
    try {
        const client = createCloudClient(entry, unseal(provider.sealed)?.key);
        await client.prove();
        const { models } = await client.list();
        provider.models = models.slice(0, 500).map((model) => ({ name: model.name, title: model.cloud?.title || null, contextLength: model.cloud?.contextLength || null, vision: Boolean(model.cloud?.vision), maxOutput: model.cloud?.maxOutput || null }));
        provider.health = provider.models.length > 0 ? 'healthy' : 'empty';
    } catch (error) {
        provider.health = PROVIDER_FAULTS[mapOllamaError(error).code] || 'unreachable';
    }
    provider.checkedAt = new Date();
    await provider.save();
    return provider;
};

const findProvider = async (req, res) => {
    const provider = await Provider.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id }).select('+sealed');
    if (!provider) res.status(404).json({ success: false, message: 'Online service not found' });
    return provider;
};

export const listProviders = asyncHandler(async (req, res) => {
    const providers = await Provider.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 });
    res.status(200).json({
        success: true,
        providers: providers.map(presentProvider),
        suggested: CLOUD_PROVIDERS.map(({ id, name, does, key }) => ({ id, name, does, key }))
    });
});

export const addProvider = asyncHandler(async (req, res) => {
    const entry = CLOUD_PROVIDERS.find((one) => one.id === req.body.kind);
    if (!entry) return res.status(404).json({ success: false, message: 'That online service is not one Mollama knows.' });
    if (await Provider.exists({ service: SERVICE, owner: req.user.id, kind: entry.id })) return res.status(409).json({ success: false, message: `${entry.name} is already connected.`, action: 'Replace its key instead.' });
    if (await Provider.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_PROVIDERS) return res.status(422).json({ success: false, message: 'You have reached the limit of online services.' });
    const provider = await checkProvider(await Provider.create({ owner: req.user.id, kind: entry.id, name: entry.name, sealed: seal({ key: req.body.key }) }));
    res.status(201).json({ success: true, provider: presentProvider(provider) });
});

export const checkProviderNow = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    res.status(200).json({ success: true, provider: presentProvider(await checkProvider(provider)) });
});

export const updateProvider = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    provider.sealed = seal({ key: req.body.key });
    res.status(200).json({ success: true, provider: presentProvider(await checkProvider(provider)) });
});

export const removeProvider = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    await provider.deleteOne();
    res.status(200).json({ success: true, message: 'Online service removed.' });
});

// Tools a chat has switched on. Built-in ones are functions here; the rest come from the person's tool servers.
const MAX_CHAT_TOOLS = 40;
const TOOL_RESULT_CHARS = 20000;
const TOOL_CALLS_AN_HOUR = 120;
const PERMISSION_WAIT_MS = 3 * 60 * 1000;

const toolArguments = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(String(raw || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

export const BUILTIN_TOOLS = [
    {
        id: 'date_time',
        name: 'Date and time',
        description: 'Get the current date and time, optionally in a named time zone.',
        parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'A time zone name such as Europe/London. Leave out for UTC.' } } },
        run: async ({ timezone }) => {
            const now = new Date();
            try {
                return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone || 'UTC' }).format(now);
            } catch {
                return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(now)} (the time zone "${clip(timezone, 60)}" is not one I know, so this is UTC)`;
            }
        }
    },
    {
        id: 'calculator',
        name: 'Calculator',
        description: 'Work out an arithmetic expression exactly. Supports + - * / % ^ and brackets.',
        parameters: { type: 'object', properties: { expression: { type: 'string', description: 'For example (12.5 * 4) / 3 ^ 2' } }, required: ['expression'] },
        run: async ({ expression }) => {
            const text = String(expression ?? '').trim();
            if (!text || text.length > 300 || !/^[\d\s+\-*/().,%^]+$/.test(text)) return 'That is not an arithmetic expression. Use numbers with + - * / % ^ and brackets only.';
            try {
                const value = Function(`"use strict"; return (${text.replace(/\^/g, '**').replace(/,/g, '')});`)();
                return Number.isFinite(value) ? String(value) : 'The result is not a finite number.';
            } catch {
                return 'That expression could not be worked out. Check the brackets and operators.';
            }
        }
    },
    {
        id: 'read_web_page',
        name: 'Read a web page',
        description: 'Fetch a public web page by its full https address and return its title and text.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full address, starting with https://' } }, required: ['url'] },
        run: async ({ url }) => {
            if (!/^https:\/\//i.test(String(url || ''))) return 'This tool needs a full address that starts with https://';
            const page = await readPage(String(url));
            return JSON.stringify({ title: clip(page?.title, 200), content: clip(page?.content, 8000) });
        }
    }
];

const toolName = (taken, prefix, name) => {
    const base = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    let unique = base;
    for (let copy = 2; taken.has(unique); copy += 1) unique = `${base.slice(0, 56)}_${copy}`;
    taken.add(unique);
    return unique;
};
const textOfResult = (result) => {
    const pieces = Array.isArray(result?.content) ? result.content : [];
    const text = pieces.map((piece) => (piece.type === 'text' ? piece.text : piece.type === 'resource' ? piece.resource?.text || '' : `[${piece.type}]`)).join('\n').trim();
    return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : 'The tool returned nothing.');
};

// Every tool the chat may use this turn, each with the name the model calls it by and the way to run it.
const toolsForChat = async (chat, userId) => {
    // The built-in tools are always there for a model that can use tools; a chat chooses only among its connected tools.
    const chosen = chat.tools || [];
    const taken = new Set(['web_search', 'web_fetch']);
    const tools = BUILTIN_TOOLS.map((tool) => {
        taken.add(tool.id);
        return { fn: tool.id, label: tool.name, changes: false, definition: { type: 'function', function: { name: tool.id, description: tool.description, parameters: tool.parameters } }, run: async (input) => ({ content: await tool.run(input), failed: null }) };
    });
    const ids = chosen.filter((id) => mongoose.isValidObjectId(id));
    const servers = ids.length ? await ToolServer.find({ _id: { $in: ids }, service: SERVICE, owner: userId, health: 'healthy' }).select('+sealed').sort({ name: 1 }) : [];
    for (const server of servers) {
        for (const tool of server.tools) {
            const fn = toolName(taken, server.name.toLowerCase(), tool.name);
            tools.push({
                fn,
                label: `${server.name}: ${tool.title || tool.name}`,
                changes: !tool.readOnly,
                definition: { type: 'function', function: { name: fn, description: clip(tool.description, 600), parameters: tool.input || { type: 'object', properties: {} } } },
                run: (input) => callServerTool(server, tool.name, input)
            });
        }
    }
    return tools.slice(0, MAX_CHAT_TOOLS);
};

const callServerTool = async (server, name, input) => {
    if (server.kind === 'local') {
        if (!deviceGateway.isOnline(server.device)) return { content: 'That computer is not connected, so the tool could not run. The Mollama desktop app has to be open on it.', failed: 'offline' };
        const answer = await deviceGateway.tools(server.device, { action: 'call', localId: server.localId, name, arguments: input });
        return { content: clip(answer?.content || 'The tool returned nothing.', TOOL_RESULT_CHARS), failed: answer?.isError ? 'failed' : null };
    }
    const kept = unseal(server.sealed) || {};
    const keeper = kept.key ? null : accountKeeper(kept, kept.redirect);
    const result = await withToolServer({ address: server.address, key: kept.key, keeper }, (client) => client.callTool({ name, arguments: input }, { timeout: 60000 }));
    if (keeper) await ToolServer.updateOne({ _id: server._id }, { sealed: seal(kept) });
    return { content: clip(textOfResult(result), TOOL_RESULT_CHARS), failed: result?.isError ? 'failed' : null };
};

const toolCalls = new Map();
const underLimit = (userId) => {
    const now = Date.now();
    const kept = toolCalls.get(String(userId));
    const window = kept && now - kept.since < 60 * 60 * 1000 ? kept : { since: now, count: 0 };
    window.count += 1;
    toolCalls.set(String(userId), window);
    return window.count <= TOOL_CALLS_AN_HOUR;
};

// A tool that changes something waits here until the person allows or refuses it; no answer in time is a refusal.
const permissions = new Map();
const askPermission = (chat, tool, input, write) => new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => settle('no'), PERMISSION_WAIT_MS);
    timer.unref?.();
    const settle = (answer) => {
        clearTimeout(timer);
        permissions.delete(id);
        resolve(answer);
    };
    permissions.set(id, { chatId: chat.id, settle });
    write({ type: 'permission', id, tool: tool.label, input: clip(JSON.stringify(input), 500) });
});

export const waitingPermissions = () => [...permissions.entries()].map(([id, waiting]) => ({ id, chatId: waiting.chatId }));

export const answerPermission = asyncHandler(async (req, res) => {
    const chat = await Chat.exists({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    const waiting = permissions.get(req.body.id);
    if (!chat || !waiting || waiting.chatId !== req.params.id) return res.status(404).json({ success: false, message: 'That question is no longer waiting for an answer.' });
    waiting.settle(req.body.answer);
    res.status(200).json({ success: true });
});

const runChatTool = async (tool, input, { chat, userId, write, stopped, show }) => {
    try {
        if (!underLimit(userId)) return { content: 'The limit on tool use for this hour has been reached. Answer without tools and say so.', failed: 'limited' };
        if (tool.changes && !(chat.allowedTools || []).includes(tool.fn)) {
            const answer = await askPermission(chat, tool, input, write);
            if (stopped()) return { content: 'The reply was stopped.', failed: 'refused' };
            if (answer === 'no') return { content: 'The person did not allow this tool to run. Do not try another way to do the same thing; say that it was not done.', failed: 'refused' };
            if (answer === 'always') chat.allowedTools = [...(chat.allowedTools || []), tool.fn];
        }
        return await tool.run(input, { show });
    } catch (error) {
        const code = mapOllamaError(error).code;
        logger.warn('[Chat] Tool failed', { tool: tool.fn, code });
        return { content: `Error: ${clip(error?.message || 'the tool could not be run', 300)}`, failed: code === 'REMOTE_BLOCKED' ? 'blocked' : code === 'DEVICE_OFFLINE' ? 'offline' : 'unreachable' };
    }
};
