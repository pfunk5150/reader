import {
    RPCHost,
} from 'civkit';
import { singleton } from 'tsyringe';
import {
    Logger, RPCMethod
} from '../shared';
import _ from 'lodash';

import { APICall } from '../shared/db/api-roll';
import { Crawled } from '../db/crawled';
import { ImgAlt } from '../db/img-alt';
import { PDFContent } from '../db/pdf';
import { SearchResult } from '../db/searched';



@singleton()
export class FixerHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async fixApiRoll() {
        let i = 0;
        while (true) {
            const records = await APICall.fromFirestoreQuery(APICall.COLLECTION.where('createdAt', '>=', '').limit(100));
            if (!records.length) {
                break;
            }
            await Promise.all(records.map(x => x._ref!.set({ createdAt: x.createdAt, expireAt: x.expireAt }, { merge: true })));
            i += records.length;
            this.logger.info(`Fixed APIRoll ${i} records`);
        }

        this.logger.info(`Done fixing ${i} APIRoll records`);
    }

    async fixCrawled() {
        let i = 0;
        while (true) {
            const records = await Crawled.fromFirestoreQuery(Crawled.COLLECTION.where('createdAt', '>=', '').limit(100));
            if (!records.length) {
                break;
            }
            await Promise.all(records.map(x => x._ref!.set({ createdAt: x.createdAt, expireAt: x.expireAt }, { merge: true })));
            i += records.length;
            this.logger.info(`Fixed Crawled ${i} records`);
        }

        this.logger.info(`Done fixing ${i} Crawled records`);
    }

    async fixImageAlts() {
        let i = 0;
        while (true) {
            const records = await ImgAlt.fromFirestoreQuery(ImgAlt.COLLECTION.where('createdAt', '>=', '').limit(100));
            if (!records.length) {
                break;
            }
            await Promise.all(records.map(x => x._ref!.set({ createdAt: x.createdAt }, { merge: true })));
            i += records.length;
            this.logger.info(`Fixed ImgAlt ${i} records`);
        }

        this.logger.info(`Done fixing ${i} ImgAlt records`);
    }

    async fixPDFs() {
        let i = 0;
        while (true) {
            const records = await PDFContent.fromFirestoreQuery(PDFContent.COLLECTION.where('createdAt', '>=', '').limit(100));
            if (!records.length) {
                break;
            }
            await Promise.all(records.map(x => x._ref!.set({ createdAt: x.createdAt, expireAt: x.expireAt }, { merge: true })));
            i += records.length;
            this.logger.info(`Fixed PDFContent ${i} records`);
        }

        this.logger.info(`Done fixing ${i} PDFContent records`);
    }

    async fixSearchResults() {
        let i = 0;
        while (true) {
            const records = await SearchResult.fromFirestoreQuery(SearchResult.COLLECTION.where('createdAt', '>=', '').limit(100));
            if (!records.length) {
                break;
            }
            await Promise.all(records.map(x => x._ref!.set({ createdAt: x.createdAt, expireAt: x.expireAt }, { merge: true })));
            i += records.length;
            this.logger.info(`Fixed SearchResult ${i} records`);
        }

        this.logger.info(`Done fixing ${i} SearchResult records`);
    }

    @RPCMethod({
        exportInGroup: ['api'],
        httpMethod: ['get', 'post'],
        runtime: {
            timeoutSeconds: 3600,
        }
    })
    async fixAll() {
        await Promise.all([
            this.fixApiRoll(),
            this.fixCrawled(),
            this.fixImageAlts(),
            this.fixPDFs(),
            this.fixSearchResults(),
        ]);

        this.logger.info(`Done fixing all records`);

        return true;
    }
}
