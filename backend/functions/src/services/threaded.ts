import { AbstractRPCRegistry, perNextTick } from 'civkit';
import _ from 'lodash';
import { container, singleton } from 'tsyringe';

import { isMainThread, Worker, parentPort, workerData } from 'worker_threads';

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
        if (isMainThread){
            return;
        }
        if (workerData.type !== this.constructor.name){
            return;
        }
        this.filesToLoad = _.uniq([...(workerData.filesToLoad || []), ...this.filesToLoad])
        for (const f of this.filesToLoad) {
            require(f);
        }

        this.notifyOngoingTasks();
        setInterval(()=> this.notifyOngoingTasks(), 1000).unref();

        this.emit('ready');
    }

}

const instance = container.resolve(ThreadedServiceRegistry);

export default instance;
export const { Method: ThreadedMethod, Param, Ctx, RPCReflect } = instance.decorators();