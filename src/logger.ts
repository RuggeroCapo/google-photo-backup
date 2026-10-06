import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

const MAX_LOG_BYTES = 50 * 1024 * 1024;

/** Logs to stdout and, if a log dir is configured, to `<logDir>/agent.log` (rotated once at startup when large). */
export function createLogger(level: string, logDir: string | null): Logger {
  const streams: pino.StreamEntry[] = [{ level: level as pino.Level, stream: process.stdout }];
  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const file = path.join(logDir, 'agent.log');
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
      streams.push({ level: level as pino.Level, stream: pino.destination({ dest: file, sync: false, mkdir: true }) });
    } catch (err) {
      process.stderr.write(`Cannot write logs to ${logDir}: ${(err as Error).message}\n`);
    }
  }
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, pino.multistream(streams));
}
