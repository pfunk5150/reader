import puppeteer, { Browser } from 'puppeteer';
import genericPool from 'generic-pool';
import os from 'os';
import fs from 'fs';
import EventEmitter from 'events';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (data?: T | Promise<T> | void) => void;
    reject: (err?: any | void) => void;
}
function Defer<T = unknown>(): Deferred<T> {
    const self: any = {};
    self.promise = new Promise<T>((resolve, reject) => {
        self.resolve = resolve;
        self.reject = reject;
    });
    Object.freeze(self);

    return self;
}


const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');

export class PuppeteerControl extends EventEmitter {

    status: 'init' | 'crippled' | 'ready' = 'init';

    browser!: Browser;

    pagePool = genericPool.createPool({
        create: async () => {
            const page = await this.newPage();
            return page;
        },
        destroy: async (page) => {
            await page.browserContext().close();
        },
        validate: async (page) => {
            return this.browser.connected && !page.isClosed();
        }
    }, {
        max: 1 + Math.floor(os.freemem() / 1024 * 1024 * 1024),
        min: 1,
    });

    constructor() {
        super(...arguments);
        this.on('ready', () => this.status = 'ready');
        this.on('crippled', () => this.status = 'crippled');
    }

    async init() {
        if (this.status === 'ready') {
            return;
        }
        if (this.browser) {
            await this.browser.close();
        }
        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        this.browser.once('disconnected', () => {
            this.emit('crippled');
        });

        this.emit('ready');
    }

    async newPage() {
        await this.init();
        const dedicatedContext = await this.browser.createBrowserContext();

        const page = await dedicatedContext.newPage();
        await page.setUserAgent(`Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`);
        await page.setViewport({ width: 1920, height: 1080 });
        await page.exposeFunction('reportSnapshot', (snapshot: any) => {
            page.emit('snapshot', snapshot);
        });

        await page.evaluateOnNewDocument(READABILITY_JS);

        await page.evaluateOnNewDocument(() => {
            function giveSnapshot() {
                // @ts-expect-error
                return new Readability(document.cloneNode(true)).parse();
            };
            let aftershot: any;
            const handlePageLoad = () => {
                // @ts-expect-error
                if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
                    return;
                }

                const parsed = giveSnapshot();
                if (parsed) {
                    // @ts-expect-error
                    window.reportSnapshot(parsed);
                } else {
                    if (aftershot) {
                        clearTimeout(aftershot);
                    }
                    aftershot = setTimeout(() => {
                        // @ts-expect-error
                        window.reportSnapshot(giveSnapshot());
                    }, 500);
                }
            };
            // setInterval(handlePageLoad, 1000);
            // @ts-expect-error
            document.addEventListener('readystatechange', handlePageLoad);
            // @ts-expect-error
            document.addEventListener('load', handlePageLoad);
        });

        // TODO: further setup the page;

        return page;
    }

    async *scrap(url: string) {
        const page = await this.pagePool.acquire();
        let snapshot: unknown;
        let nextSnapshotDeferred = Defer();
        let finalized = false;
        const hdl = (s: any) => {
            if (snapshot === s) {
                return;
            }
            snapshot = s;
            nextSnapshotDeferred.resolve(s);
            nextSnapshotDeferred = Defer();
        };
        page.on('snapshot', hdl);
        const gotoPromise = page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
        gotoPromise.finally(() => finalized = true);

        try {
            while (true) {
                await Promise.race([nextSnapshotDeferred.promise, gotoPromise]);
                const screenshot = await page.screenshot();
                if (finalized) {
                    await gotoPromise;
                    snapshot = await page.evaluate('new Readability(document.cloneNode(true)).parse()');
                    yield { snapshot, screenshot };
                    break;
                }
                yield { snapshot, screenshot };
            }
        } catch (_err) {
            void 0;
        } finally {
            page.off('snapshot', hdl);
            await this.pagePool.destroy(page);
        }

    }

}

const puppeteerControl = new PuppeteerControl();

export default puppeteerControl;
