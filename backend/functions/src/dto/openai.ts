import { AutoCastable, Prop } from 'civkit';

export class OpenAIMessage extends AutoCastable {

    @Prop({
        required: true,
        type: String,
    })
    role!: 'user' | 'system' | 'assistant' | string;

    @Prop({
        default: '',
        type: String,
        nullable: true,
    })
    content!: string | null;

    @Prop({
        type: String,
    })
    name?: string;
}

export class OpenAISystemMessage extends OpenAIMessage {
    @Prop({
        required: true,
        validate: (v: 'system') => v === 'system',
    })
    override role!: 'system';

    @Prop({
        default: '',
        type: String,
        required: true,
        validate: (v) => v.length > 0,
    })
    override content!: string;
}

export class OpenAIUserMessage extends OpenAIMessage {
    @Prop({
        required: true,
        validate: (v: 'user') => v === 'user',
    })
    override role!: 'user';

    @Prop({
        default: '',
        type: String,
        required: true,
        validate: (v) => v.length > 0,
    })
    override content!: string;
}

export class OpenAIFunctionCall extends AutoCastable {
    @Prop({
        required: true
    })
    name!: string;

    @Prop({
        required: true
    })
    arguments!: string;
}

export class OpenAIToolCall extends AutoCastable {
    @Prop({
        required: true
    })
    id!: string;

    @Prop({
        default: 'function',
        required: true
    })
    type!: string;

    @Prop({
        required: true
    })
    function!: OpenAIFunctionCall;
}

export class OpenAIAssistantMessage extends OpenAIMessage {
    @Prop({
        required: true,
        validate: (v: 'assistant') => v === 'assistant',
    })
    override role!: 'assistant';

    @Prop()
    tool_calls?: OpenAIToolCall[];
}

export class OpenAIToolMessage extends OpenAIMessage {
    @Prop({
        required: true,
        validate: (v: 'tool') => v === 'tool',
    })
    override role!: 'tool';

    @Prop({
        default: '',
        type: String,
        required: true,
        validate: (v) => v.length > 0,
    })
    override content!: string;

    @Prop({
        required: true,
    })
    tool_call_id!: string;
}

export class LLMModelOptions<T extends object = any> extends AutoCastable {

    @Prop()
    system?: string;

    @Prop({
        arrayOf: [OpenAIUserMessage, OpenAISystemMessage, OpenAIAssistantMessage, OpenAIToolMessage],
    })
    messages?: Array<OpenAIUserMessage | OpenAISystemMessage | OpenAIAssistantMessage | OpenAIToolMessage>;

    @Prop({ arrayOf: String })
    stop?: string[];

    @Prop()
    stream?: boolean;

    @Prop({ validate: (v: number) => v > 0 })
    max_tokens?: number;

    @Prop({ validate: (v: number) => v >= 0 })
    temperature?: number;

    @Prop({ validate: (v: number) => v >= 0 && v <= 1 })
    top_p?: number;

    @Prop({ validate: (v: number) => v >= 0 })
    top_k?: number;

    @Prop()
    seed?: number;

    @Prop({ validate: (v: number) => v >= 0 && v <= 4 })
    n?: number;

    @Prop({ arrayOf: Object })
    functions?: any[];

    @Prop({ type: Object })
    function_call?: { name: string; } | string;

    @Prop({ type: Object })
    modelSpecific?: T;

}
