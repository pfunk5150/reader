import { AbstractRPCRegistry, RPCHost, OpenAPIManager } from 'civkit';
import { container, singleton } from 'tsyringe';
import { LLMModelOptions } from '../shared/services/common-llm';
import { Logger } from '../shared';
import { CrawlerHost } from './crawler';
import { SearcherHost } from './searcher';

@singleton()
export class InteractiveOptimizerFunctionsRegistry2 extends AbstractRPCRegistry {
    override container = container;

    openAPIManager = new OpenAPIManager();

    constructor() {
        super(...arguments);

        this.openAPIManager.enrichDescriptions = false;
    }

    getFunctionsCallingDescriptors(whitelist?: string[]) {
        const final = [];

        for (const [k, v] of this.conf) {
            final.push({
                name: k,
                description: v.desc,
                parameters: this.openAPIManager.createRPCParametersSchemaObject(v)
            });
        }

        if (!whitelist) {
            return final;
        }

        return final.filter((x) => whitelist.includes(x.name));
    }

    getPromptMixin(callOptions: LLMModelOptions<any>, whitelist?: string[]) {
        if (!whitelist) {
            return {};
        }
        if (callOptions.function_call === 'none') {
            return {};
        }

        const descriptors = this.getFunctionsCallingDescriptors(whitelist);

        let enforce: string | undefined;
        if ((callOptions.function_call as any)?.name) {
            const descriptor = descriptors.find((x) => x.name === (callOptions.function_call as any).name);
            if (!descriptor) {
                return {};
            }
            enforce = descriptor.name;
            descriptors.length = 0;
            descriptors.push(descriptor);
        }

        const systemPrompt = `Being a smart assistant, there are several tools made available to you (described in JSON list below):
${JSON.stringify(descriptors)}

Rules:
To invoke one or more tools, you need to respond (and only respond) with a clean JSON object with the following structure:
${JSON.stringify({
            intention: 'USE_TOOLS',
            thoughts: 'I need to demonstrate the use of tools',
            tools: [
                {
                    name: 'exampleTool1',
                    arguments: {
                        exampleArgName1: 'exampleValue1', exampleArgName2: 'ExampleValue2'
                    },
                    id: 'TOOL_1_CALL_1'
                },
                {
                    name: 'exampleTool2',
                    arguments: {
                        argumentName: 'value format is defined by each tool description'
                    },
                    id: 'TOOL_2_CALL_1'
                },
            ]
        })}
This means your response must start with '{' and end with '}'.
You MUST first declare your intention to be exactly USE_TOOLS, then describe your thoughts, and finally list the tool(s) you want to use.
Provide the name of the tool and the arguments you would like to pass.
The arguments must be a JSON object with its internal structure as defined by the description of each tool (JSON Schema).
Always give an id for each tool call, this is to distinguish between multiple calls when the system responds.
Only then the system will pick up this special format and respond to you in the following message(s), after witch you can continue with responding normal content to the user.
You should always respond to the user in normal format after invoking the tool(s).

${enforce ? `At this time, you MUST invoke the tool named "${enforce}". This is forcefully required by the system.` : 'It would also be perfectly fine if you choose to not invoke any tool. In that case you should directly respond normal content to the user.'}`;

        return { system: systemPrompt, functions: descriptors };
    }
}
const oFn = container.resolve(InteractiveOptimizerFunctionsRegistry2);


@singleton()
export class ReaderAsLLMTools extends RPCHost {
    logger = this.globalLogger.child({ service: this.constructor.name });

    constructor(
        protected globalLogger: Logger,
        protected crawlerHost: CrawlerHost,
        protected searcherHost: SearcherHost,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @oFn.Method({
        desc: `Browse and return the content of a specific url.`
    })
    async browse(
        @oFn.Param('url', {
            required: true,
            desc: 'The URL to get content from. In plain text'
        }) url: URL,
    ) {
        if (!url) {
            throw new Error('URL is required');
        }

        const formattedPage = await this.crawlerHost.simpleCrawl('markdown', url);

        return formattedPage.content;
    }

    @oFn.Method({
        desc: `Search the web using a search engine.`
    })
    async searchTheWeb(
        @oFn.Param('text', {
            required: true,
            desc: 'The text to put into search box.'
        }) text: string
    ) {
        if (!text) {
            throw new Error('text is required');
        }

        const thing = await this.searcherHost.cachedWebSearch({ q: text });

        return thing.web.results.map((x) => ({ url: x.url, title: x.title, description: x.description }));
    }

}
