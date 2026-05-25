import type { InjectionDetection, RunContext } from 'ottrix';

declare global {
  namespace Express {
    interface Request {
      ottrixRunContext?: RunContext;
      ottrixInjection?: InjectionDetection;
    }
  }
}

export type { InjectionDetection, RunContext };
