import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ApprovalDecision } from './human-approval.js';

/** Utility for signing and verifying approval decisions as JWTs. */
export class DecisionSigner {
  constructor(private readonly secret: string) {}

  signJwt(decision: ApprovalDecision): string {
    return signJwt(decision, this.secret);
  }

  verifyJwt(token: string): ApprovalDecision {
    return verifyJwt(token, this.secret);
  }
}

/** Sign an approval decision as an HMAC-SHA256 JWT. */
export function signJwt(decision: ApprovalDecision, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(decision));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Verify a JWT and return the embedded approval decision. */
export function verifyJwt(token: string, secret: string): ApprovalDecision {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid JWT signature');
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ApprovalDecision;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
