import mongoose from 'mongoose';
import { Joi } from '../utils/validator.js';

export const SERVICE = 'ai-base';

const gpuSchema = new mongoose.Schema({
    name: { type: String, required: true },
    memoryMb: { type: Number, required: true }
}, { _id: false });

const hardwareSchema = new mongoose.Schema({
    hostname: String,
    platform: String,
    cpu: String,
    cpuThreads: Number,
    memoryMb: Number,
    gpus: { type: [gpuSchema], default: [] },
    gpuMemoryMb: Number,
    diskFreeMb: Number,
    diskTotalMb: Number,
    modelsPath: String,
    detectedAt: Date
}, { _id: false });

const overridesSchema = new mongoose.Schema({
    memoryMb: { type: Number, default: null },
    gpuName: { type: String, default: null },
    gpuMemoryMb: { type: Number, default: null }
}, { _id: false });

const deviceSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['local', 'companion'], required: true },
    hostname: { type: String, required: true },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hardware: { type: hardwareSchema, default: null },
    overrides: { type: overridesSchema, default: () => ({}) },
    lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

deviceSchema.index({ service: 1, kind: 1, hostname: 1 }, { unique: true });

const settingSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, unique: true },
    ollamaBaseUrl: { type: String, default: null },
    defaultModel: { type: String, default: null },
    maxConcurrentGenerations: { type: Number, default: 1, min: 1, max: 8 },
    keepAliveMinutes: { type: Number, default: 5, min: 0, max: 1440 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

export const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);
export const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const personalModelSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    from: { type: String, required: true },
    system: { type: String, default: '' },
    parameters: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

personalModelSchema.index({ service: 1, name: 1 }, { unique: true });

const downloadSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    model: { type: String, required: true },
    status: {
        type: String,
        enum: ['queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled'],
        default: 'queued',
        index: true
    },
    completedBytes: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
    errorCode: { type: String, default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
}, { timestamps: true });

export const PersonalModel = mongoose.models.PersonalModel || mongoose.model('PersonalModel', personalModelSchema);
export const Download = mongoose.models.Download || mongoose.model('Download', downloadSchema);

const ollamaUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(300);

export const deviceSchemas = {
    deviceId: Joi.object({
        id: Joi.objectId().required()
    }),

    updateDevice: Joi.object({
        name: Joi.string().trim().min(1).max(80),
        overrides: Joi.object({
            memoryMb: Joi.number().integer().min(512).max(4194304).allow(null),
            gpuName: Joi.string().trim().max(120).allow(null, ''),
            gpuMemoryMb: Joi.number().integer().min(0).max(1048576).allow(null)
        })
    }).min(1),

    updateSettings: Joi.object({
        ollamaBaseUrl: ollamaUrl.allow(null, ''),
        defaultModel: Joi.string().trim().max(200).pattern(/^[A-Za-z0-9._\-/:]+$/).allow(null, ''),
        maxConcurrentGenerations: Joi.number().integer().min(1).max(8),
        keepAliveMinutes: Joi.number().integer().min(0).max(1440)
    }).min(1),

    testConnection: Joi.object({
        ollamaBaseUrl: ollamaUrl.required()
    })
};

const modelName = Joi.string().min(1).max(200).pattern(/^[A-Za-z0-9._\-/:]+$/)
    .messages({ 'string.pattern.base': 'Model name may only contain letters, digits and . - _ / :' });

const megabytes = Joi.number().integer().min(0).max(4194304);

export const modelSchemas = {
    named: Joi.object({
        name: modelName.required()
    }),

    create: Joi.object({
        name: Joi.string().min(1).max(63).pattern(/^[a-z0-9][a-z0-9._-]*$/).required()
            .messages({ 'string.pattern.base': 'Use lower-case letters, digits, dots, dashes and underscores only' }),
        displayName: Joi.string().trim().min(1).max(80).required(),
        from: modelName.required(),
        system: Joi.string().max(20000).allow(''),
        template: Joi.string().max(20000).allow(''),
        parameters: Joi.object().pattern(
            Joi.string().max(60),
            Joi.alternatives().try(Joi.string().max(500), Joi.number(), Joi.boolean())
        ).max(30)
    }),

    downloadAction: Joi.object({
        id: Joi.objectId().required(),
        action: Joi.string().valid('pause', 'cancel').required()
    }),

    catalogueQuery: Joi.object({
        memoryMb: megabytes,
        gpuMemoryMb: megabytes
    })
};
