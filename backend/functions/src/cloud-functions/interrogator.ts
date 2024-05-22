import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection, UploadedFile,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, Ctx, InsufficientBalanceError, Logger, OutputServerEventStream, Param, PromptChunk, RPCMethod, RPCReflect } from '../shared';
import { RateLimitControl } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { CrawlerHost } from './crawler';

import { SearcherHost } from './searcher';
import { LLMModelOptions } from '../shared/dto/llm';
import { readFile } from 'fs/promises';
import { CrawlerOptions } from '../dto/scrapping-options';


@singleton()
export class InterrogatorHost extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,

        protected crawler: CrawlerHost,
        protected searcher: SearcherHost,
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
            concurrency: 4,
            maxInstances: 200,
        },
        openapi: {
            operation: {
                parameters: {
                    'Accept': {
                        description: `Specifies your preference for the response format. \n\n` +
                            `Supported formats:\n` +
                            `- text/event-stream\n` +
                            `- application/json  or  text/json\n` +
                            `- text/plain`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-No-Cache': {
                        description: `Ignores internal cache if this header is specified with a value.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Respond-With': {
                        description: `Specifies the (non-default) form factor of the crawled data you prefer. \n\n` +
                            `Supported formats:\n` +
                            `- markdown\n` +
                            `- html\n` +
                            `- text\n` +
                            `- screenshot\n`
                        ,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Proxy-Url': {
                        description: `Specifies your custom proxy if you prefer to use one. \n\n` +
                            `Supported protocols:\n` +
                            `- http\n` +
                            `- https\n` +
                            `- socks4\n` +
                            `- socks5\n\n` +
                            `For authentication, https://user:pass@host:port`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-Set-Cookie': {
                        description: `Sets cookie(s) to the headless browser for your request. \n\n` +
                            `Syntax is the same with standard Set-Cookie`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Generated-Alt': {
                        description: `Enable automatic alt-text generating for images without an meaningful alt-text.\n\n` +
                            `Note: Does not work when \`X-Respond-With\` is specified`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-Images-Summary': {
                        description: `Enable dedicated summary section for images on the page.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                    'X-With-links-Summary': {
                        description: `Enable dedicated summary section for hyper links on the page.`,
                        in: 'header',
                        schema: { type: 'string' }
                    },
                }
            }
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
        @Param('model') model?: string,
        @Param('prompt', { type: String }) prompt?: string,
        @Param('expandImages') expandImages?: boolean,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;

        if (uid) {
            const user = await auth.assertUser();
            if (!(user.wallet.total_balance > 0)) {
                throw new InsufficientBalanceError(`Account balance not enough to run this query, please recharge.`);
            }

            const apiRoll = await this.rateLimitControl.simpleRPCUidBasedLimit(rpcReflect, uid, ['INTERROGATE'],
                [
                    // 40 requests per minute
                    new Date(Date.now() - 60 * 1000), 40
                ]
            );

            rpcReflect.finally(() => {
                if (chargeAmount) {
                    auth.reportUsage(chargeAmount, 'reader-interrogate').catch((err) => {
                        this.logger.warn(`Unable to report usage for ${uid}`, { err: marshalErrorLike(err) });
                    });
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        } else if (ctx.req.ip) {
            this.threadLocal.set('ip', ctx.req.ip);
            const apiRoll = await this.rateLimitControl.simpleRpcIPBasedLimit(rpcReflect, ctx.req.ip, ['INTERROGATE'],
                [
                    // 5 requests per minute
                    new Date(Date.now() - 60 * 1000), 5
                ]
            );
            rpcReflect.finally(() => {
                if (chargeAmount) {
                    apiRoll.chargeAmount = chargeAmount;
                }
            });
        }

        const crawlerConf = this.crawler.configure(crawlerOptions);
        this.threadLocal.set('expandImages', expandImages ?? false);

        return assignTransferProtocolMeta(`${crawlerConf}`, { contentType: 'text/plain', envelope: null });
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
