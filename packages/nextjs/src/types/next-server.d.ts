declare module 'next/server' {
  export class NextRequest extends Request {
    readonly nextUrl: URL;
  }

  export class NextResponse extends Response {
    static next(init?: ResponseInit): NextResponse;
    static json(body: unknown, init?: ResponseInit): NextResponse;
  }
}
