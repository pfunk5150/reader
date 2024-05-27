import {
    Defer,
    PromiseThrottle,
    RPCHost,
    RPCReflection,
} from 'civkit';
import { singleton } from 'tsyringe';
import { CloudHTTPv2, CloudScheduleV2, FirebaseStorageBucketControl, Logger, OutputServerEventStream, RPCReflect, TempFileManager } from '../shared';
import _ from 'lodash';
import { CrawlerHost } from './crawler';

import { Crawled } from '../db/crawled';
import dayjs from 'dayjs';
import { createReadStream, createWriteStream } from 'fs';
dayjs.extend(require('dayjs/plugin/utc'));

@singleton()
export class DataCrunchingHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    pageCacheCrunchingPrefix = 'crunched-pages';
    pageCacheCrunchingBatchSize = 10000;
    pageCacheCrunchingTMinus = 31 * 24 * 60 * 60 * 1000;
    rev = 2;

    constructor(
        protected globalLogger: Logger,

        protected crawler: CrawlerHost,
        protected tempFileManager: TempFileManager,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(..._.without(arguments, crawler));
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @CloudScheduleV2('2 0 * * *', {
        name: 'crunchPageCacheEveryday',
        runtime: {
            cpu: 4,
            memory: '8GiB',
            timeoutSeconds: 1800,
            timeZone: 'UTC',
            retryCount: 3,
            minBackoffSeconds: 60,
        },
        tags: ['DataCrunching'],
    })
    @CloudHTTPv2({
        runtime: {
            cpu: 4,
            memory: '8GiB',
            timeoutSeconds: 3600,
            concurrency: 1,
            maxInstances: 1,
        },
        tags: ['DataCrunching'],
    })
    async crunchPageCache(
        @RPCReflect() rpcReflect: RPCReflection
    ) {
        const sse = new OutputServerEventStream();
        rpcReflect.return(sse);
        rpcReflect.catch((err) => {
            sse.end({ data: `Error: ${err.message}` });
        });
        this.logger.info(`Crunching page cache...`);
        sse.write({ data: 'Crunching page cache...' });
        for await (const { fileName, records } of this.iterPageCacheCrunching()) {
            this.logger.info(`Crunching ${fileName}...`);
            sse.write({ data: `Crunching ${fileName}...` });
            const fileOnDrive = await this.crunchCacheRecords(records);
            await this.firebaseObjectStorage.bucket.file(fileName).save(createReadStream(fileOnDrive.path), {
                contentType: 'application/jsonl',
            });
        }

        this.logger.info(`Crunching page cache done.`);
        sse.end({ data: `Crunching page cache done.` });

        return true;
    }

    async* iterPageCacheCrunching() {
        const startOfToday = dayjs().utc().startOf('day');
        const startingPoint = dayjs().utc().subtract(this.pageCacheCrunchingTMinus, 'ms').startOf('day');
        let theDay = startingPoint;

        let counter = 0;

        while (theDay.isBefore(startOfToday)) {
            const fileName = `${this.pageCacheCrunchingPrefix}/r${this.rev}/${theDay.format('YYYY-MM-DD')}-${counter ? counter : '00000'}.jsonl`;
            const offset = counter;
            counter += this.pageCacheCrunchingBatchSize;
            const fileExists = (await this.firebaseObjectStorage.bucket.file(fileName).exists())[0];
            if (fileExists) {
                continue;
            }

            const records = await Crawled.fromFirestoreQuery(Crawled.COLLECTION
                .where('createdAt', '>=', theDay.toDate())
                .where('createdAt', '<', theDay.add(1, 'day').toDate())
                .orderBy('createdAt', 'asc')
                .offset(offset)
                .limit(this.pageCacheCrunchingBatchSize)
            );

            this.logger.info(`Found ${records.length} records for ${theDay.format('YYYY-MM-DD')} at offset ${offset}`, { fileName, counter });

            if (!records.length) {
                theDay = theDay.add(1, 'day');
                counter = 0;
                continue;
            }

            yield { fileName, records };
        }
    }

    async crunchCacheRecords(records: Crawled[]) {
        const throttle = new PromiseThrottle(100);
        const localFileName = this.tempFileManager.alloc();
        const fileWriteStream = createWriteStream(localFileName, { encoding: 'utf-8' });
        let nextDrainDeferred = Defer();
        nextDrainDeferred.resolve();

        for (const record of records) {
            await throttle.acquire();
            this.firebaseObjectStorage.downloadFile(`snapshots/${record._id}`)
                .then(async (snapshotTxt) => {
                    try {
                        const snapshot = JSON.parse(snapshotTxt.toString('utf-8'));

                        let formatted = await this.crawler.formatSnapshot('default', snapshot);
                        if (!formatted.content) {
                            formatted = await this.crawler.formatSnapshot('markdown', snapshot);
                        }

                        await nextDrainDeferred.promise;
                        const wr = fileWriteStream.write(
                            JSON.stringify({
                                url: snapshot.href,
                                html: snapshot.html || '',
                                content: formatted.content || '',
                            }) + '\n'
                        );
                        if (wr === false) {
                            nextDrainDeferred = Defer();
                            fileWriteStream.once('drain', () => {
                                nextDrainDeferred.resolve();
                            });
                        }
                    } catch (err) {
                        this.logger.warn(`Failed to parse snapshot for ${record._id}`, { err });
                    }
                })
                .finally(() => {
                    throttle.release();
                });
        }

        await throttle.nextDrain();

        fileWriteStream.end();

        const ro = {
            path: localFileName
        };

        this.tempFileManager.bindPathTo(ro, localFileName);

        return ro;
    }
}
