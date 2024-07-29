import { AbstractRPCRegistry, perNextTick } from 'civkit';
import _ from 'lodash';
import { container, singleton } from 'tsyringe';

import { isMainThread, Worker, parentPort, workerData, threadId, MessageChannel } from 'node:worker_threads';

@singleton()
export class ThreadedServiceRegistry extends AbstractRPCRegistry {

    override container = container;

    filesToLoad: string[] = [];
    workers: Worker[] = [];

    ongoingTasks = 0;

    loadInWorker(file: string) {
        this.filesToLoad.push(file);
    }

    initMain() {

    }

    createWorker() {
        const worker = new Worker(__filename, {
            workerData: {
                type: this.constructor.name,
                filesToLoad: this.filesToLoad,
            }
        });

        this.workers.push(worker);

        return worker;
    }

    @perNextTick()
    notifyOngoingTasks() {
        if (isMainThread) {
            return;
        }
        parentPort?.postMessage({
            channel: this.constructor.name,
            event: 'reportOngoingTasks',
            data: this.ongoingTasks,
        });
    }

    override async exec(name: string, input: object, env?: object): Promise<any> {
        this.ongoingTasks += 1;
        this.notifyOngoingTasks();

        try {
            return await super.exec(name, input, env);
        } finally {
            this.ongoingTasks -= 1;
            this.notifyOngoingTasks();
        }
    }

    initWorker() {
        if (isMainThread) {
            return;
        }
        if (workerData.type !== this.constructor.name) {
            return;
        }
        this.filesToLoad = _.uniq([...(workerData.filesToLoad || []), ...this.filesToLoad]);
        for (const f of this.filesToLoad) {
            require(f);
        }

        this.notifyOngoingTasks();
        setInterval(() => this.notifyOngoingTasks(), 1000).unref();

        parentPort!.on('message', (msg) => {
            if (msg?.channel === this.constructor.name && msg?.event === 'exec') {
                this.ongoingTasks = msg.data;
            }
        });
        parentPort!.once('error', (err) => {
            console.error(err);
            process.exit(1);
        });

        this.emit('ready');
    }

}

const instance = container.resolve(ThreadedServiceRegistry);

export default instance;
export const { Method: ThreadedMethod, Param, Ctx, RPCReflect } = instance.decorators();


const FROM_MESSAGE_PORT_SYMBOL = Symbol('FROM_MESSAGE_PORT');

export function fromMessagePort<T extends abstract new (...args: any) => any>(this: T, port: MessagePort, instant: object): InstanceType<T> {
    Object.setPrototypeOf(instant, this.prototype);

    return instant as any;
}

let serial = 0;
const objTrack = new WeakMap();
function track(obj: object) {
    if (typeof obj !== 'object') {
        return null;
    }

    const n = objTrack.get(obj);

    if (n) {
        return `${threadId}__${n}`;
    }

    const newN = ++serial;
    objTrack.set(obj, newN);

    return `${threadId}__${newN}`;
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
