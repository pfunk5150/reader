import 'reflect-metadata';
import { initializeApp } from 'firebase-admin/app';
initializeApp();

import { loadModulesDynamically, registry } from './shared';
import path from 'path';
loadModulesDynamically(path.resolve(__dirname, 'cloud-functions'));

Object.assign(exports, registry.exportGrouped({
    memory: '4GiB',
    timeoutSeconds: 540,
}));
registry.title = 'url2text';
registry.version = '0.1.0';
