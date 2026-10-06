import { PhotoBackupAgent } from '../src/app.js';
import type { DB } from '../src/db/database.js';
import { FakeUploader, silentLogger, testConfig } from './helpers.js';

export interface TestAgent {
  agent: PhotoBackupAgent;
  uploader: FakeUploader;
  clock: { now: number; advance(ms: number): void; set(d: Date): void };
}

/**
 * Agent wired with a fake uploader (no rclone, no Google) and a controllable
 * clock. Starts without the background scan/watch: tests call `ingest()`.
 */
export async function startAgent(
  root: string,
  env: Record<string, string> = {},
  opts: { uploader?: FakeUploader; db?: DB; start?: Date } = {},
): Promise<TestAgent & { ingest(): Promise<void> }> {
  const uploader = opts.uploader ?? new FakeUploader();
  const clock = {
    now: (opts.start ?? new Date()).getTime(),
    advance(ms: number) {
      this.now += ms;
      agent.worker.notify();
    },
    set(d: Date) {
      this.now = d.getTime();
      agent.worker.notify();
    },
  };
  const agent = new PhotoBackupAgent(testConfig(root, env), {
    logger: silentLogger,
    uploader,
    db: opts.db,
    clock: () => clock.now,
    idlePollMs: 20,
  });
  await agent.start({ scan: false, watch: false });
  return {
    agent,
    uploader,
    clock,
    async ingest() {
      await agent.scanner.scan();
      await agent.ingestor.waitIdle();
      agent.worker.notify();
    },
  };
}
