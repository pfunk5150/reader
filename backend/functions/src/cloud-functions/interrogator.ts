import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection, UploadedFile,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, countGPTToken, Ctx, InsufficientBalanceError, LLMManager, Logger, OutputServerEventStream, Param, PromptChunk, RPCMethod, RPCReflect } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { CrawlerHost } from './crawler';

import { SearcherHost } from './searcher';
import { LLMModelOptions, LLMModelOptionsOpenAICompat } from '../shared/dto/llm';
import { readFile } from 'fs/promises';
import { CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';
import { Readable } from 'stream';



@singleton()
export class InterrogatorHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,

        protected crawler: CrawlerHost,
        protected searcher: SearcherHost,

        protected llmManager: LLMManager,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @RPCMethod({
        runtime: {
            cpu: 4,
            memory: '8GiB',
            timeoutSeconds: 300,
            concurrency: 8,
            maxInstances: 200,
        },
        exportInGroup: ['api'],
        tags: ['Interrogator'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    async interrogate(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        inputOptions: LLMModelOptions,
        crawlerOptions: CrawlerOptions,
        @Param('url', {
            required: true,
            validate(url: URL) {
                return url.protocol === 'http:' || url.protocol === 'https:';
            }
        }) url: URL,
        @Param('model', { default: 'gpt-3.5-turbo' }) model: string,
        @Param('question', {
            type: String,
            required: true,
            validate(txt: string) {
                return txt.length > 0 && countGPTToken(txt) <= 2048;
            }
        }) prompt: string,
        @Param('expandImages') expandImages?: boolean,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [RateLimitDesc.from({
                occurrence: 40,
                periodSeconds: 60
            })];

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, [rpcReflect.name.toUpperCase()],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.req.ip) {
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, [rpcReflect.name.toUpperCase()],
                [
                    // 5 requests per minute
                    new Date(Date.now() - 60 * 1000), 5
                ]
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    apiRoll._ref?.set({
                        chargeAmount,
                    }, { merge: true }).catch((err) => this.logger.warn(`Failed to log charge amount in apiRoll`, { err }));
                }
            });
        }

        const mdl = this.llmManager.assertModel(model);
        const crawlerConf = this.crawler.configure(crawlerOptions);
        this.threadLocal.set('expandImages', expandImages ?? false);
        const page = await this.crawler.simpleCrawl(crawlerOptions.respondWith, url, crawlerConf);

        const content = page.toString();
        const promptChunks = expandImages ? await this.expandMarkdown(content) : [content];
        promptChunks.unshift('===== Start Of Webpage Content =====\n');
        promptChunks.push('===== End Of Webpage Content =====\n\n');
        promptChunks.push(`${prompt}`);

        const r = await mdl.exec(promptChunks, inputOptions);

        if (Readable.isReadable(r as any)) {
            const outputStream = new OutputServerEventStream();
            (r as any as Readable).pipe(outputStream);

            return outputStream;
        }

        return assignTransferProtocolMeta(r.trim() + '\n', { contentType: 'text/plain', envelope: null });
    }

    @RPCMethod({
        runtime: {
            cpu: 4,
            memory: '8GiB',
            timeoutSeconds: 300,
            concurrency: 8,
            maxInstances: 200,
        },
        exportInGroup: ['api'],
        tags: ['Interrogator'],
        httpMethod: ['get', 'post'],
        returnType: [String, OutputServerEventStream],
    })
    async chatWithReader(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        inputOptions: LLMModelOptionsOpenAICompat,
        crawlerOptions: CrawlerOptionsHeaderOnly,
        @Param('model', { default: 'gpt-3.5-turbo' }) model: string,
        @Param('expandImages') expandImages?: boolean,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const rateLimitPolicy = auth.getRateLimits(rpcReflect.name.toUpperCase()) || [RateLimitDesc.from({
                occurrence: 40,
                periodSeconds: 60
            })];

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(
                rpcReflect, uid, [rpcReflect.name.toUpperCase()],
                ...rateLimitPolicy
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, `reader-${rpcReflect.name}`).catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.req.ip) {
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, [rpcReflect.name.toUpperCase()],
                [
                    // 5 requests per minute
                    new Date(Date.now() - 60 * 1000), 5
                ]
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    apiRoll._ref?.set({
                        chargeAmount,
                    }, { merge: true }).catch((err) => this.logger.warn(`Failed to log charge amount in apiRoll`, { err }));
                }
            });
        }

        const mdl = this.llmManager.assertModel(model);

        const r = await mdl.exec('', inputOptions);

        if (Readable.isReadable(r as any)) {
            const outputStream = new OutputServerEventStream();
            (r as any as Readable).pipe(outputStream);

            return outputStream;
        }

        return assignTransferProtocolMeta(r.trim() + '\n', { contentType: 'text/plain', envelope: null });
    }


    async expandMarkdown(input: string, files: { [k: string]: UploadedFile; } = {}) {
        const result: PromptChunk[] = [];
        const imageRegex = /!\[(.*?)\]\((.*?)\)/g;

        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = imageRegex.exec(input)) !== null) {
            // Add the text before the image
            if (match.index > lastIndex) {
                result.push(input.substring(lastIndex, match.index));
            }

            // Extract the alt text and image URL
            // const altText = match[1];
            const imageUrl = match[2];

            // Validate and add the URL object
            try {
                const urlObject = new URL(imageUrl, 'file://');

                if (urlObject.protocol === 'file:') {
                    const origFileName = urlObject.pathname.substring(1);
                    const fileNameDecoded = decodeURI(origFileName);
                    const fileNameEncoded = encodeURI(origFileName);
                    const file = files[origFileName] || files[fileNameDecoded] || files[fileNameEncoded];

                    if (file) {
                        const fpath = await file.filePath;
                        const buff = await readFile(fpath);

                        result.push(buff);
                    }
                } else {
                    result.push(urlObject);
                }

            } catch (error) {
                // If the URL is invalid, add the raw image markdown instead
                result.push(match[0]);
            }

            // Add the image markdown
            result.push(match[0]);

            // Update the lastIndex to the end of the current match
            lastIndex = imageRegex.lastIndex;
        }

        // Add any remaining text after the last image
        if (lastIndex < input.length) {
            result.push(input.substring(lastIndex));
        }

        // Merge consecutive string elements
        const mergedResult: PromptChunk[] = [];
        let tempString = "";

        for (const item of result) {
            if (typeof item === "string") {
                tempString += item;
            } else {
                if (tempString) {
                    mergedResult.push(tempString);
                    tempString = "";
                }
                mergedResult.push(item);
            }
        }

        if (tempString) {
            mergedResult.push(tempString);
        }

        return mergedResult;
    }
}
