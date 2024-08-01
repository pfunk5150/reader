import { AsyncService } from 'civkit';
import { Duplex, Readable, Writable } from 'node:stream';
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


export function streamToAsyncIterable(theStream: Stream) {

}
