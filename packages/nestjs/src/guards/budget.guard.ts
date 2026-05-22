import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GuardrailService } from '../services/guardrail.service.js';

/**
 * NestJS guard that rejects requests when org-scoped Ottrix budgets are exhausted.
 *
 * Requires an authenticated `request.user.orgId`. Budget enforcement for agent
 * runs still happens authoritatively in guardrail middleware after RunContext is set.
 */
@Injectable()
export class BudgetGuard implements CanActivate {
  constructor(private readonly guardrails: GuardrailService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: { orgId?: string };
    }>();

    const orgId = request.user?.orgId;
    if (!orgId) {
      return true;
    }

    const remaining = await this.guardrails
      .getBudgetGuardrail()
      .getScopeRemaining('org', orgId);

    const tokenLimit = remaining.tokens.limit;
    const costLimit = remaining.costUsd.limit;

    if (tokenLimit === undefined && costLimit === undefined) {
      return true;
    }

    if (tokenLimit !== undefined && (remaining.tokens.remaining ?? 0) <= 0) {
      throw new ForbiddenException(`Token budget exhausted for org ${orgId}`);
    }

    if (costLimit !== undefined && (remaining.costUsd.remaining ?? 0) <= 0) {
      throw new ForbiddenException(`Cost budget exhausted for org ${orgId}`);
    }

    return true;
  }
}
