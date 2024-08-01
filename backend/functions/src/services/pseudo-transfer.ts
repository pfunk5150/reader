import { AsyncService, isPrimitiveLike } from 'civkit';
import _ from 'lodash';
import { Duplex, EventEmitter, Readable, Writable } from 'node:stream';
import { parentPort, threadId } from 'node:worker_threads';
type Constructor<T = any> = abstract new (...args: any) => T;

type SpecialMixin = 'Promise' | 'EventEmitter' | 'AsyncIterable';

interface PropertyDescriptor {
    type: 'property' | 'getter&setter' | 'getter' | 'setter';
    value?: AnyDescriptor;
    writable: boolean;
    enumerable: boolean;
    configurable: boolean;
}

interface ObjectDescriptor {
    type: 'object';
    oid: string;
    propertyDescriptors: {
        [key: string]: PropertyDescriptor;
    };
    constructorName: string;
    nativeValue?: any;
    mixins?: SpecialMixin[];
}
interface FunctionDescriptor {
    type: 'function';
    oid: string;
    propertyDescriptors: {
        [key: string]: PropertyDescriptor;
    };
    mixins?: SpecialMixin[];
}
interface ValueDescriptor {
    type: 'primitive';
    value: number | boolean | string | null | undefined | bigint;
}

type AnyDescriptor = ObjectDescriptor | FunctionDescriptor | ValueDescriptor;

const NATIVELY_TRANSFERABLE = [Map, Set, RegExp, BigInt, Date, ArrayBuffer, SharedArrayBuffer, WebAssembly.Module];
function isNativelyTransferable(input: object) {

    for (const x of NATIVELY_TRANSFERABLE) {
        if (input instanceof x) {
            return true;
        }
    }

    return false;
}

export const SYM_PSEUDO_TRANSFERABLE = Symbol('PseudoTransferable');

type SpecialTraits = 'EventEmitter' | 'Promise' | 'AsyncIterator' | 'thisArg';
export interface PseudoTransferableOptions {
    copyOwnProperty: 'all' | 'none' | 'enumerable' | string[];
    ignoreOwnProperty?: string[];

    imitateMethods?: string[];
    imitateSpecialTraits?: SpecialTraits[];
}
export interface PseudoTransferable {
    [SYM_PSEUDO_TRANSFERABLE]: () => PseudoTransferableOptions;
}

type TransferMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PseudoTransferProfile {
    path: string[];
    mode: TransferMode;
    traits: SpecialTraits[];
    oid?: string;
    constructorName?: string;
    oMethods?: string[];
}

export function detectSpecialTraits(input: any) {
    if (!input || !['function', 'object'].includes(typeof input)) {
        return [];
    }

    const traits: Array<'EventEmitter' | 'Promise' | 'AsyncIterator'> = [];

    if (typeof input.then === 'function') {
        traits.push('Promise');
    }
    if (input instanceof EventEmitter) {
        traits.push('EventEmitter');
    }
    if (typeof input?.[Symbol.asyncIterator] === 'function') {
        traits.push('AsyncIterator');
    }

    if (traits.length) {
        return traits;
    }

    return [];
}

export class PseudoTransfer<T extends EventTarget = Worker> extends AsyncService {

    trackedSerialToObject = new Map();
    trackedObjectToSerial = new WeakMap();

    pseudoTransferableTypes = new Map<string, Constructor>;

    receivedObject = new WeakMap<object | Function, string>;
    receivedObjectOrigin = new WeakMap<object | Function, T>;

    serial = 0n;

    primaryPort = parentPort;

    serialToId(n: number | bigint) {
        return `${threadId}__${n}`;
    }

    idToSerial(id: string) {
        return BigInt(id.split('__')[1]);
    }

    track(obj: object) {
        if (typeof obj !== 'object') {
            throw new Error('Only objects can be tracked.');
        }

        const n = this.trackedObjectToSerial.get(obj);

        if (n) {
            return this.serialToId(n);
        }

        const newId = ++this.serial;
        this.trackedObjectToSerial.set(obj, newId);
        this.trackedSerialToObject.set(newId, obj);

        return this.serialToId(newId);
    }

    drop(id: string) {
        const n = this.idToSerial(id);
        this.trackedSerialToObject.delete(n);
    }

    expectPseudoTransferableType(type: Constructor) {
        if (this.pseudoTransferableTypes.has(type.name)) {
            throw new Error(`Duplicated type name: ${type.name}`);
        }
        this.pseudoTransferableTypes.set(type.name, type);
    }


    export(input: any): AnyDescriptor {
        if (typeof input !== 'object' && typeof input !== 'function') {
            return {
                type: 'primitive',
                value: input,
            };
        }

        const id = this.track(input);
        const propertyDescriptors = Object.getOwnPropertyDescriptors(input);
        const desc = {
            type: typeof input,
            constructorName: input.constructor.name,
            oid: id,
            propertyDescriptors: {},
            mixins: [],
        } as ObjectDescriptor | FunctionDescriptor;
        const omitProperties = new Set();

        if (Array.isArray(input)) {
            (desc as ObjectDescriptor).nativeValue = [];
        } else if (isNativelyTransferable(input)) {
            (desc as ObjectDescriptor).nativeValue = input;
        }

        if (typeof input?.then === 'function') {
            desc.mixins!.push('Promise');
            omitProperties.add('domain');
        }
        if (typeof input?.emit === 'function') {
            desc.mixins!.push('EventEmitter');
            omitProperties.add('domain');
            omitProperties.add('_events');
            omitProperties.add('_eventsCount');
        }
        if (typeof input?.[Symbol.asyncIterator] === 'function') {
            desc.mixins!.push('AsyncIterable');
            if (input instanceof Readable) {
                omitProperties.add('domain');
                omitProperties.add('_readableState');
            } else if (input instanceof Writable) {
                omitProperties.add('domain');
                omitProperties.add('_writableState');
            } else if (input instanceof Duplex) {
                omitProperties.add('domain');
                omitProperties.add('_readableState');
                omitProperties.add('_writableState');
            }
        }

        for (const [key, descriptor] of Object.entries(propertyDescriptors)) {
            if (typeof key !== 'string') {
                continue;
            }
            if (omitProperties.has(key)) {
                continue;
            }
            const mappedDesc = {
                writable: descriptor.writable,
                enumerable: descriptor.enumerable,
                configurable: descriptor.configurable,
            } as typeof desc['propertyDescriptors'][string];
            if (descriptor.hasOwnProperty('value')) {
                mappedDesc.type = 'property';
                mappedDesc.value = this.export(descriptor.value);
            } else if (descriptor.hasOwnProperty('get') && descriptor.hasOwnProperty('set')) {
                mappedDesc.type = 'getter&setter';
            } else if (descriptor.hasOwnProperty('get')) {
                mappedDesc.type = 'getter';
            } else if (descriptor.hasOwnProperty('set')) {
                mappedDesc.type = 'setter';
            }
            desc.propertyDescriptors[key] = mappedDesc;
        }

        return desc;
    }

    prepareForTransfer(input: any): PseudoTransferProfile[] {
        if ((typeof input !== 'object' && typeof input !== 'function') || !input) {
            return [];
        }

        const profiles: [any, PseudoTransferProfile][] = [];

        const transferSettings: PseudoTransferableOptions | undefined = input[SYM_PSEUDO_TRANSFERABLE]?.();
        const topTraits: PseudoTransferProfile['traits'] = transferSettings?.imitateSpecialTraits || detectSpecialTraits(input);
        profiles.push([
            input,
            {
                path: [],
                mode: 7,
                constructorName: input.constructor?.name,
                traits: topTraits,
                oMethods: transferSettings?.imitateMethods,
            }
        ]);
        for (const [path, val, mode, traits, imitateMethods] of deepVectorizeForTransfer(input, undefined, undefined, topTraits)) {
            profiles.push([
                val,
                {
                    path,
                    mode,
                    constructorName: val.constructor?.name,
                    traits: traits === null ? [] : traits,
                    oMethods: imitateMethods,
                }
            ]);
        }

        return profiles.map(([val, profile]) => {
            if (profile.traits?.length || profile.oMethods?.length) {
                profile.oid = this.track(val);
            }

            return profile;
        });
    }

    callRemoteFunction(origin: T, fnOid: string, thisArgOid: string, args: any[]) {

    };

    import(input: AnyDescriptor): any {
        if (input.type === 'primitive') {
            return input.value;
        }

        this.trackedObjectToSerial.set(instance, this.idToSerial(oid));

        for (const [key, descriptor] of Object.entries(propertyDescriptors)) {
            if (descriptor.type === 'property') {
                Object.defineProperty(instance, key, {
                    writable: descriptor.writable,
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable,
                    value: this.import(descriptor.value!),
                });
            } else if (descriptor.type === 'getter&setter') {
                Object.defineProperty(instance, key, {
                    get: () => this.import(descriptor.value!),
                    set: (v) => this.import(descriptor.value!),
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable,
                });
            } else if (descriptor.type === 'getter') {
                Object.defineProperty(instance, key, {
                    get: () => this.import(descriptor.value!),
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable,
                });
            } else if (descriptor.type === 'setter') {
                Object.defineProperty(instance, key, {
                    set: (v) => this.import(descriptor.value!),
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable,
                });
            }
        }

        return instance;
    }

}


export function toMessagePort<T extends abstract new (...args: any) => any>(this: T, instant: InstanceType<T>, upstreamPort = parentPort): MessagePort[] {
    if (!upstreamPort) {
        throw new Error('Upstream port required.');
    }

    const ports = [];
    const serial = track(instant);

    // Thenable
    if (typeof instant?.then === 'function') {
        const chan = new MessageChannel();
        const port = chan.port1;
        upstreamPort.postMessage({
            event: 'contactRemoteObject',
            oid: serial,
            type: 'thenable',
            port: chan.port2,
        }, [chan.port2]);

        instant.then((resolved: any) => {
            port.postMessage({
                event: 'resolve',
                data: resolved,
            });
            port.close();
        }, (rejected: any) => {
            port.postMessage({
                event: 'reject',
                data: rejected,
            });
            port.close();
        });

        ports.push(port);
    }

    // Iterator
    if (typeof instant?.[Symbol.asyncIterator] === 'function') {
        const chan = new MessageChannel();
        const port = chan.port1;
        upstreamPort.postMessage({
            event: 'contactRemoteObject',
            type: 'asyncIterable',
            port: chan.port2,
        }, [chan.port2]);

        port.on('message', async (msg) => {
            const { event, data } = msg.data;
            const iterable: AsyncIterator<unknown> = instant[Symbol.asyncIterator]();

            switch (event) {
                case 'next':
                    try {
                        const next = await iterable.next(data);
                        port.postMessage({
                            event: 'next',
                            data: next,
                        });
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                case 'return':
                    try {
                        const ret = await iterable.return?.(data);
                        port.postMessage({
                            event: 'return',
                            data: ret,
                        });
                        port.close();
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                case 'throw':
                    try {
                        const ret = await iterable.throw?.(data);
                        port.postMessage({
                            event: 'throw',
                            data: ret,
                        });
                        port.close();
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                default: {
                    break;
                }
            }
        });

        ports.push(port);
    } else if (typeof instant?.[Symbol.iterator] === 'function') {
        const chan = new MessageChannel();
        const port = chan.port1;
        upstreamPort.postMessage({
            event: 'contactRemoteObject',
            oid: serial,
            type: 'iterable',
            port: chan.port2,
        }, [chan.port2 as any]);

        port.onmessage = function (msg) {
            const { event, data } = msg.data;
            const iterable: Iterator<unknown> = instant[Symbol.iterator]();

            switch (event) {
                case 'next':
                    try {
                        const next = iterable.next(data);
                        port.postMessage({
                            event: 'next',
                            data: next,
                        });
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                case 'return':
                    try {
                        const ret = iterable.return?.(data);
                        port.postMessage({
                            event: 'return',
                            data: ret,
                        });
                        port.close();
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                case 'throw':
                    try {
                        const ret = iterable.throw?.(data);
                        port.postMessage({
                            event: 'throw',
                            data: ret,
                        });
                        port.close();
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                default: {
                    break;
                }
            }
        };

        ports.push(port);

    }

    // EventEmitter
    if (typeof instance?.emit === 'function') {
        const chan = new MessageChannel();
        const port = chan.port1;
        upstreamPort.postMessage({
            event: 'contactRemoteObject',
            type: 'eventEmitter',
            port: chan.port2,
        }, [chan.port2 as any]);

        port.onmessage = function (msg) {
            const { event, data } = msg.data;

            switch (event) {
                case 'emit':
                    try {
                        instance.emit(data.event, data.data);
                    } catch (err) {
                        port.postMessage({
                            event: 'error',
                            data: err,
                        });
                        port.close();
                    }
                    break;
                default: {
                    break;
                }
            }
        };

        ports.push(port);
    }

    return ports;
}

function getConfigMode(d: PropertyDescriptor) {
    return ((d.enumerable ? 1 << 2 : 0) | (d.writable ? 1 << 1 : 0) | (d.configurable ? 1 : 0)) as TransferMode;
}

export function* deepVectorizeForTransfer(
    obj: any,
    stack: string[] = [],
    refStack: WeakSet<any> = new WeakSet(),
    parentTraits?: SpecialTraits[] | null
): Iterable<[string[], any, TransferMode, SpecialTraits[] | null, string[] | undefined]> {
    if (!(obj && typeof obj.hasOwnProperty === 'function')) {
        return;
    }

    const propertyDescriptors = Object.getOwnPropertyDescriptors(obj);
    const transferSettings: PseudoTransferableOptions | undefined = obj[SYM_PSEUDO_TRANSFERABLE]?.();

    if (Array.isArray(transferSettings?.imitateMethods)) {
        if (transferSettings!.imitateMethods.length && parentTraits) {
            if (!parentTraits.includes('thisArg')) {
                parentTraits.push('thisArg');
            }
        }
    }

    for (const [name, descriptor] of Object.entries(propertyDescriptors)) {
        if (typeof name !== 'string') {
            continue;
        }
        if (transferSettings?.ignoreOwnProperty?.includes(name)) {
            continue;
        }
        if ((!transferSettings?.copyOwnProperty || (transferSettings.copyOwnProperty === 'enumerable')) && !descriptor.enumerable) {
            continue;
        } else if (transferSettings?.copyOwnProperty === 'none') {
            continue;
        } else if (Array.isArray(transferSettings?.copyOwnProperty) && !transferSettings!.copyOwnProperty.includes(name)) {
            continue;
        }
        let val;
        try {
            val = Reflect.get(obj, name);
        } catch (err) {
            // Maybe some kind of getter and it throws.
            val = null;
        }

        const valTransferSettings: PseudoTransferableOptions | undefined = val[SYM_PSEUDO_TRANSFERABLE]?.();
        const valTraits = valTransferSettings?.imitateSpecialTraits || detectSpecialTraits(val);

        if (refStack.has(val)) {
            // Circular
            yield [stack.concat(name), val, getConfigMode(descriptor as PropertyDescriptor), null, undefined];

            continue;
        }

        if (isPrimitiveLike(val) && typeof val !== 'function' && !descriptor.enumerable) {
            yield [stack.concat(name), val, getConfigMode(descriptor as PropertyDescriptor), valTraits, valTransferSettings?.imitateMethods];

            continue;
        }

        refStack.add(val);
        if (typeof val === 'function') {
            if (parentTraits && !parentTraits.includes('thisArg')) {
                parentTraits.push('thisArg');
            }
        }
        if (val !== null && typeof val === 'object' || typeof val === 'function') {
            if ((!_.isPlainObject(val) && !_.isArray(val) && !_.isArguments(val)) || valTransferSettings?.imitateSpecialTraits) {
                yield [stack.concat(name), val, getConfigMode(descriptor as PropertyDescriptor), valTraits, valTransferSettings?.imitateMethods];
            }

            yield* deepVectorizeForTransfer(val, stack.concat(name), refStack, valTraits);
        }
    }

    return;
}
