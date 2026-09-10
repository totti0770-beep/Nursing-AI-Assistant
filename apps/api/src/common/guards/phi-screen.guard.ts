import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PHI_REJECTION_MESSAGE_AR,
  PhiCategory,
  PhiProfile,
  scanForPhi,
} from '@bnp/shared';
import { PHI_SCREEN_KEY, PhiScreenSpec } from '../decorators';
import { phiMrnPattern } from '../../config/env';
import { AuditService } from '../../audit/audit.service';

/**
 * Rejects patient identifiers before they can be stored or sent anywhere.
 *
 * **Why a guard and not a DTO constraint.** Nest runs guards → interceptors →
 * pipes → handler. A `class-validator` rule lives in the pipe, which is late
 * enough to prevent persistence but too late to be the whole answer here: it
 * cannot emit the interception record without container plumbing, and it
 * cannot see `GET /rag/search?q=`, which has no DTO at all.
 *
 * Running as a guard buys something stronger than convenience. Because a guard
 * throws *before* the interceptor chain, `AuditInterceptor` never runs on a
 * rejected request — so there is no `HTTP:POST:/chat/ask` row, no
 * `ERROR:400` row, and no code path that could carry the body into the audit
 * trail. "Rejected text is never written to any store" is therefore a property
 * of where this runs, not a promise about what the code remembers to avoid.
 * The only row written is the one below, and it carries categories, never
 * content.
 *
 * Screening is opt-in per route via `@ScreenForPhi(...)`, not applied blindly
 * to every string field. An undecorated route is visibly undecorated in the
 * controller, which is easier to review than a global rule with an exception
 * list.
 */
@Injectable()
export class PhiScreenGuard implements CanActivate {
  private readonly logger = new Logger('PhiScreen');

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const spec = this.reflector.getAllAndOverride<PhiScreenSpec | undefined>(
      PHI_SCREEN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!spec) return true;

    const req = context.switchToHttp().getRequest();
    const mrnPattern = phiMrnPattern();
    const profile = spec.profile ?? PhiProfile.FREE_TEXT;

    const found = new Set<PhiCategory>();
    for (const [source, fields] of [
      [req.body, spec.body],
      [req.query, spec.query],
    ] as const) {
      if (!fields || !source) continue;
      for (const field of fields) {
        const value = source[field];
        // Guards run before the ValidationPipe, so a field can be anything the
        // client sent. Only strings are screenable; a non-string is left for
        // the pipe to reject on its own terms.
        if (typeof value !== 'string') continue;
        for (const category of scanForPhi(value, { profile, mrnPattern })) {
          found.add(category);
        }
      }
    }

    if (found.size === 0) return true;

    const categories = [...found].sort();
    // Per-category from day one: the operating question in the first weeks is
    // not "how many rejections" but "which pattern is rejecting legitimate
    // clinical questions". A single total cannot answer that, and adding the
    // breakdown later would leave the pilot period unmeasurable.
    this.audit.record({
      actorId: req.user?.userId ?? null,
      actorEmail: req.user?.email ?? null,
      action: 'SECURITY:PHI_BLOCKED',
      resourceType: 'http',
      metadata: {
        route: req.route?.path ?? req.path,
        categories,
        profile,
      },
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
    // Categories only, never the text — the log is a store like any other.
    this.logger.warn(
      `Blocked input on ${req.route?.path ?? req.path}: ${categories.join(', ')}`,
    );

    throw new BadRequestException(PHI_REJECTION_MESSAGE_AR);
  }
}
