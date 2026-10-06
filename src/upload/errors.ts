import type { UploadErrorKind } from '../types.js';

export interface ErrorClassification {
  kind: UploadErrorKind;
  retryable: boolean;
}

const RATE_LIMIT = /\b429\b|rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|quota exceeded|too many requests/i;

const NETWORK =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|no such host|connection reset|connection refused|i\/o timeout|TLS handshake timeout|network is unreachable|unexpected EOF|broken pipe|context deadline exceeded|dial tcp|server misbehaving|temporary failure in name resolution|Client\.Timeout/i;

const SERVER =
  /\b(?:error|status|http|code)[\s:]*5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|backendError|internalError/i;

/** Problems with configuration/credentials: not the file's fault, retrying it alone won't help. */
const CONFIG =
  /invalid_grant|invalid_client|unauthorized_client|token expired|oauth2: cannot fetch token|couldn't find section|didn't find section|config file .* not found|not found in config file|\b401\b|invalid authentication|unauthenticated|account (?:is )?suspended|insufficient (?:authentication )?scopes/i;

const PERMANENT =
  /\b400\b|INVALID_ARGUMENT|invalid media|unsupported (?:file|media)|not supported|file too large|no such file or directory|directory not found|object not found|is a directory/i;

/**
 * Map an rclone failure to an error kind.
 * rclone exit codes: 1 syntax/usage, 2 uncategorised, 3 dir not found,
 * 4 file not found, 5 temporary, 6 less serious, 7 fatal, 8 transfer limit,
 * 9 nothing transferred, 10 duration exceeded.
 */
export function classifyRcloneFailure(exitCode: number | null, output: string): ErrorClassification {
  if (RATE_LIMIT.test(output)) return { kind: 'rate_limit', retryable: true };
  if (NETWORK.test(output)) return { kind: 'network', retryable: true };
  if (SERVER.test(output)) return { kind: 'server', retryable: true };
  if (CONFIG.test(output)) return { kind: 'config', retryable: true };
  if (PERMANENT.test(output)) return { kind: 'permanent', retryable: false };

  switch (exitCode) {
    case 1:
    case 7:
      return { kind: 'config', retryable: true };
    case 3:
    case 4:
      return { kind: 'permanent', retryable: false };
    case 5:
      return { kind: 'network', retryable: true };
    case 8:
    case 10:
      return { kind: 'rate_limit', retryable: true };
    default:
      return { kind: 'unknown', retryable: true };
  }
}

/** Last meaningful lines of rclone output, for the `error` column. */
export function summarizeOutput(output: string, maxLen = 1000): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLines = lines.filter((l) => /error|fail|critical/i.test(l));
  const picked = (errorLines.length ? errorLines : lines).slice(-3).join(' | ');
  return picked.length > maxLen ? picked.slice(0, maxLen) + '…' : picked;
}
