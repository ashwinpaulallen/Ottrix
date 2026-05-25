import { NextResponse, type NextRequest } from 'next/server';
import { extractMessage, scanMessageForInjection } from 'ottrix/http';

/** Options for {@link createOttrixMiddleware}. */
export interface OttrixMiddlewareOptions {
  injection?: {
    mode: 'block' | 'flag';
    /** Only scan POST requests matching these path prefixes. @defaultValue `['/api/']` */
    paths?: string[];
    bodyField?: string;
  };
}

/** Default Next.js middleware matcher for API routes. */
export const ottrixMatcher = {
  matcher: '/api/:path*',
};

function matchesPath(pathname: string, paths?: string[]): boolean {
  const prefixes = paths?.length ? paths : ['/api/'];
  return prefixes.some((prefix) => pathname.startsWith(prefix) || pathname === prefix);
}

/**
 * Next.js middleware helper for prompt-injection protection on API routes.
 * Uses regex pattern matching only (edge-safe, no LLM calls).
 */
export function createOttrixMiddleware(options?: OttrixMiddlewareOptions) {
  const injection = options?.injection;
  const bodyField = injection?.bodyField ?? 'message';
  const mode = injection?.mode ?? 'block';

  return async function middleware(request: NextRequest): Promise<NextResponse> {
    if (!injection || request.method !== 'POST' || !matchesPath(request.nextUrl.pathname, injection.paths)) {
      return NextResponse.next();
    }

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return NextResponse.next();
    }

    const parsed = extractMessage(body, bodyField);
    if (!parsed.ok) {
      return NextResponse.next();
    }

    const scan = await scanMessageForInjection(parsed.message, { mode });
    if (!scan.allowed) {
      return NextResponse.json(scan.body, { status: scan.status });
    }

    const response = NextResponse.next();
    if (scan.flagged) {
      response.headers.set('x-ottrix-injection-detected', 'true');
    }
    return response;
  };
}
