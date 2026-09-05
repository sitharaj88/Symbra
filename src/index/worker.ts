import { parentPort } from 'node:worker_threads';
import { extractFile } from './extract.js';

interface Job {
  id: number;
  path: string;
  content: string;
}

parentPort!.on('message', async (job: Job) => {
  try {
    const ir = await extractFile(job.path, job.content);
    parentPort!.postMessage({ id: job.id, ir });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message });
  }
});
