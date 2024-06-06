import {
    AssertionFailureError,
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection, UploadedFile,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, countGPTToken, Ctx, InsufficientBalanceError, LLMManager, Logger, OutputOpenAIChatCompletionResponseStream, OutputServerEventStream, Param, parseJSON, PromptChunk, RPCMethod, RPCReflect, trimMessages } from '../shared';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { JinaEmbeddingsAuthDTO } from '../shared/dto/jina-embeddings-auth';
import { CrawlerHost } from './crawler';

import { SearcherHost } from './searcher';
import { LLMModelOptions, LLMModelOptionsOpenAICompat } from '../shared/dto/llm';
import { readFile } from 'fs/promises';
import { CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';
import { once, Readable } from 'stream';
import { LLMToolFunctionsRegistry } from './llm-tools';
import { JSONAccumulation, JSONParserStream } from '../shared/lib/json-parse-stream';



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

        protected llmToolsRegistry: LLMToolFunctionsRegistry,
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
        returnType: OutputServerEventStream,
    })
    async chatWithReader(
        @RPCReflect() rpcReflect: RPCReflection,
        @Ctx() ctx: {
            req: Request,
            res: Response,
        },
        auth: JinaEmbeddingsAuthDTO,
        options: LLMModelOptionsOpenAICompat,
        crawlerOptions: CrawlerOptionsHeaderOnly,
        @Param('model', { default: 'gpt-3.5-turbo' }) model: string,
        @Param('maxAdditionalTurns', {
            type: Number,
            default: 5,
            validate(turns: number) {
                return turns >= 0 && turns <= 50;
            }
        }) maxAdditionalTurns: number,
    ) {
        const uid = await auth.solveUID();
        let chargeAmount = 0;
        options.stream = true;

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

        options.max_tokens ??= 4096;
        this.crawler.configure(crawlerOptions);

        const mdl = this.llmManager.assertModel(model);
        if (!mdl.streamingSupported) {
            throw new AssertionFailureError(`Model ${model} does not support streaming.`);
        }
        const functionsMixin = this.llmToolsRegistry.getPromptMixin(options);

        if (!mdl.functionCallingSupported) {
            options.system = `${options.system ? `${options.system}\n\n` : ''}${functionsMixin.system}`;
        }

        const sseStream = new OutputOpenAIChatCompletionResponseStream(mdl.name, {
            highWaterMark: 2 * 1024 * 1024
        });

        const tailMessages = [];
        let callRoundsLeft = maxAdditionalTurns;
        let keepLooping = true;
        const trimmedMessages = trimMessages('', options, mdl.windowSize - options.max_tokens);
        const waitList: Promise<any>[] = [];

        while (keepLooping && callRoundsLeft > 0) {
            let softwareFunctionCallingInAction = false;
            const thisOptions = { ...options };
            if (functionsMixin.functions && callRoundsLeft > 1) {
                thisOptions.functions = functionsMixin.functions;
                if (!mdl.functionCallingSupported && mdl.systemSupported) {
                    thisOptions.system = `${thisOptions.system || ''}${thisOptions.system ? '\n\n' : ''}${functionsMixin.system}`;
                    softwareFunctionCallingInAction = true;
                }
            }
            thisOptions.messages = [...trimmedMessages, ...tailMessages];

            const ret = await mdl.exec('', thisOptions);
            callRoundsLeft--;

            const retStream = (ret as any as Readable);
            if (!Readable.isReadable(retStream)) {
                throw new AssertionFailureError('Model did not return a stream');
            }

            // Start pseudo function calling block
            const jsonParserStream = new JSONParserStream({
                expectControlCharacterInString: true,
                expectCasingInLiteral: true,
                expectAbruptTerminationOfInput: true,
                expectContaminated: 'object',
                swallowErrors: true
            });
            const jsonAccumulationStream = new JSONAccumulation();
            jsonAccumulationStream.on('error', () => 'Do Not Throw');
            jsonParserStream.pipe(jsonAccumulationStream, { end: true });
            jsonParserStream.once('error', (err) => {
                this.logger.error('JSON parser error', { err });
                jsonAccumulationStream.destroy(err);
            });
            jsonAccumulationStream.on('data', (snapshot) => {
                if (!snapshot || typeof snapshot !== 'object') {
                    return;
                }
                sseStream.write({
                    event: 'snapshot',
                    data: snapshot,
                });
            });
            jsonAccumulationStream.once('final', (final) => {
                if (!final || typeof final !== 'object') {
                    return;
                }
                sseStream.write({
                    event: 'structured',
                    data: final,
                });
                if (final.intention !== 'USE_TOOLS') {
                    return;
                }
                const toolCalls = final.tools;
                if (!Array.isArray(toolCalls)) {
                    return;
                }
                if (softwareFunctionCallingInAction) {
                    tailMessages.push({ role: 'assistant', content: JSON.stringify(final) });
                    for (const toolCall of toolCalls) {
                        retStream.emit('call', toolCall, toolCall.id);
                    }
                }
            });
            retStream.once('end', () => {
                jsonParserStream.end();
            });
            jsonParserStream.once('n1', (n1) => {
                sseStream.write({
                    event: 'n1',
                    data: n1,
                });
            });
            jsonParserStream.once('n2', (n2) => {
                sseStream.write({
                    event: 'n2',
                    data: n2,
                });
            });
            // End pseudo function calling block

            let resp = '';
            retStream.on('data', (chunk) => {
                if (typeof chunk !== 'string') {
                    resp = chunk;
                    return;
                }
                resp = `${resp}${chunk}`;
                jsonParserStream.write(chunk);
                sseStream.write({
                    event: 'chunk',
                    data: chunk,
                });
            });

            retStream.on('call', (params: { name: string, arguments: any; }, callId?: string) => {
                if (!params?.name) {
                    return;
                }

                waitList.push(new Promise(async (resolve, _reject) => {
                    let result: any = '';
                    try {
                        const parsedArgs = typeof params.arguments === 'string' ? parseJSON(params.arguments, {
                            expectControlCharacterInString: true,
                            expectContaminated: 'object',
                        }) : (params.arguments || {});

                        sseStream.write({
                            event: 'call',
                            data: {
                                name: params.name,
                                arguments: parsedArgs,
                                id: callId,
                            },
                        });

                        sseStream.write(`Calling tool ${params.name} with arguments: ${JSON.stringify(parsedArgs, undefined, 2)}`);

                        result = await this.llmToolsRegistry.exec(
                            params.name,
                            parsedArgs
                        );

                        sseStream.write({
                            event: 'return',
                            data: {
                                name: params.name,
                                content: result,
                                id: callId,
                            },
                        });

                    } catch (err: any) {
                        result = `${err}`;
                    }

                    const historyItem = callId ? {
                        role: 'tool',
                        content: result,
                        tool_call_id: callId,
                    } : {
                        role: 'function',
                        content: result,
                        name: params.name,
                    };
                    tailMessages.push(historyItem);
                    sseStream.write({
                        event: 'injectHistory',
                        data: historyItem
                    });

                    resolve(result);
                }));

            });

            retStream.once('error', (err) => {
                keepLooping = false;
                jsonParserStream.end();
                if (!sseStream.writableEnded) {
                    sseStream.end({
                        event: 'error',
                        data: `${err.name}: ${err.message}`,
                    });
                }
            });

            await Promise.all([once(retStream, 'close'), once(jsonAccumulationStream, 'close')]);
            if (!waitList.length) {
                keepLooping = false;
            }
            const history = Reflect.get(retStream, 'history') || {
                role: 'assistant',
                content: resp,
            };
            if (keepLooping) {
                if (!softwareFunctionCallingInAction) {
                    // For softwareFunctionCallingInAction, history pushed in finalization of jsonAccumulationStream
                    tailMessages.push(history);
                }
                sseStream.write({
                    event: 'injectHistory',
                    data: history,
                });
            } else {
                sseStream.write({
                    event: 'history',
                    data: history,
                });
            }

            await Promise.all(waitList);
            waitList.length = 0;
        }
        sseStream.end();

        return sseStream;
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
