import { Router } from 'express';
import * as aiController from '../controllers/ai.controller.js';
import * as authMiddleware from '../middleware/auth.middleware.js';
import { RIGHTS } from '../config/rights.js';
import { noCacheResponse } from '../middleware/cache.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { deviceSchemas, modelSchemas } from '../models/ai.model.js';

const router = Router();

router.validRoutes = [
    '/api/v1/devices',
    '/api/v1/devices/:id',
    '/api/v1/devices/:id/detect',
    '/api/v1/settings',
    '/api/v1/settings/test-connection',
    '/api/v1/setup/status',
    '/api/v1/models',
    '/api/v1/models/running',
    '/api/v1/models/show',
    '/api/v1/models/delete',
    '/api/v1/models/create',
    '/api/v1/models/unload',
    '/api/v1/models/pull',
    '/api/v1/models/downloads',
    '/api/v1/models/downloads/stream',
    '/api/v1/models/downloads/cancel',
    '/api/v1/catalogue',
    '/api/v1/devices/:id/catalogue'
];

const signedIn = [aiController.requireDatabase, authMiddleware.verifyToken(), authMiddleware.checkPermission(RIGHTS.USE_MODELS), noCacheResponse()];
const manager = [aiController.requireDatabase, authMiddleware.verifyToken(), authMiddleware.checkPermission(RIGHTS.MANAGE_MODELS), noCacheResponse()];
const withDeviceId = validateRequest(deviceSchemas.deviceId, 'params');

router.get('/devices', ...signedIn, aiController.listDevices);
router.get('/devices/:id', ...signedIn, withDeviceId, aiController.getDevice);
router.put('/devices/:id', ...manager, withDeviceId, validateRequest(deviceSchemas.updateDevice), aiController.updateDevice);
router.post('/devices/:id/detect', ...manager, withDeviceId, aiController.detectDevice);

router.get('/settings', ...signedIn, aiController.readSettings);
router.put('/settings', ...manager, validateRequest(deviceSchemas.updateSettings), aiController.updateSettings);
router.post('/settings/test-connection', ...manager, validateRequest(deviceSchemas.testConnection), aiController.testConnection);

router.get('/setup/status', ...signedIn, aiController.getSetupStatus);

const named = validateRequest(modelSchemas.named);

router.get('/models', ...signedIn, aiController.listModels);
router.get('/models/running', ...signedIn, aiController.listRunning);
router.post('/models/show', ...signedIn, named, aiController.showModel);
router.post('/models/delete', ...manager, named, aiController.deleteModel);
router.post('/models/unload', ...manager, named, aiController.unloadModel);
router.post('/models/create', ...manager, validateRequest(modelSchemas.create), aiController.createModel);

router.post('/models/pull', ...manager, named, aiController.startDownload);
router.get('/models/downloads', ...signedIn, aiController.listDownloads);
router.get('/models/downloads/stream', ...signedIn, aiController.streamDownloads);
router.post('/models/downloads/cancel', ...manager, validateRequest(modelSchemas.downloadAction), aiController.changeDownload);

router.get('/catalogue', noCacheResponse(), validateRequest(modelSchemas.catalogueQuery, 'query'), aiController.getPublicCatalogue);
router.get('/devices/:id/catalogue', ...signedIn, withDeviceId, aiController.getDeviceCatalogue);

export default router;
