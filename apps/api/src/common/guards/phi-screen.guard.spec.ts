import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { PHI_REJECTION_MESSAGE_AR, PhiProfile } from '@bnp/shared';
import { PhiScreenGuard } from './phi-screen.guard';
import { PHI_SCREEN_KEY, PhiScreenSpec } from '../decorators';

/**
 * The guard's own contract. The end-to-end proof that nothing reaches the
 * database lives in `test/phi-screening.e2e-spec.ts`; this pins the unit-level
 * behaviour, and above all that the interception record carries categories and
 * never content.
 */

const SECRET = '1098765432'; // a national ID shape — the text that must never escape

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

function harness(spec: PhiScreenSpec | undefined) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === PHI_SCREEN_KEY ? spec : undefined,
    ),
  };
  const audit = { record: jest.fn() };
  const guard = new PhiScreenGuard(reflector as never, audit as never);
  return { guard, audit };
}

const ACTOR = { userId: 'user-1', email: 'nurse@bnp.health' };

function request(over: Record<string, unknown> = {}) {
  return {
    user: ACTOR,
    ip: '10.0.0.1',
    headers: { 'user-agent': 'jest' },
    route: { path: '/chat/ask' },
    path: '/chat/ask',
    body: {},
    query: {},
    ...over,
  };
}

describe('PhiScreenGuard — routes it does not screen', () => {
  it('lets an undecorated route through untouched', () => {
    const { guard, audit } = harness(undefined);
    expect(
      guard.canActivate(contextFor(request({ body: { question: SECRET } }))),
    ).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ignores fields the route did not list', () => {
    const { guard, audit } = harness({ body: ['question'] });
    expect(
      guard.canActivate(contextFor(request({ body: { note: SECRET } }))),
    ).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips a non-string value rather than guessing at it', () => {
    // Guards run before the ValidationPipe, so the body is whatever the client
    // sent. A number or an object is not screenable text; rejecting it here
    // would produce a PHI message for what is really a schema error, so it is
    // left for the pipe.
    const { guard } = harness({ body: ['question'] });
    for (const question of [42, null, { nested: SECRET }, [SECRET]]) {
      expect(guard.canActivate(contextFor(request({ body: { question } })))).toBe(
        true,
      );
    }
  });
});

describe('PhiScreenGuard — clean input', () => {
  it('passes a legitimate clinical question', () => {
    const { guard, audit } = harness({ body: ['question'] });
    const req = request({
      body: { question: 'ما جرعة الباراسيتامول لمريض وزنه 70 كجم؟' },
    });
    expect(guard.canActivate(contextFor(req))).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('PhiScreenGuard — rejection', () => {
  it('throws the shared message verbatim, not a controller-local string', () => {
    const { guard } = harness({ body: ['question'] });
    const req = request({ body: { question: `dose for ${SECRET}?` } });

    expect(() => guard.canActivate(contextFor(req))).toThrow(BadRequestException);
    try {
      guard.canActivate(contextFor(req));
    } catch (err) {
      expect((err as BadRequestException).message).toBe(PHI_REJECTION_MESSAGE_AR);
    }
  });

  it('records the interception with the pattern category', () => {
    const { guard, audit } = harness({ body: ['question'] });
    const req = request({ body: { question: `dose for ${SECRET}?` } });

    expect(() => guard.canActivate(contextFor(req))).toThrow();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SECURITY:PHI_BLOCKED',
        actorId: 'user-1',
        actorEmail: 'nurse@bnp.health',
        metadata: expect.objectContaining({
          route: '/chat/ask',
          categories: ['NATIONAL_ID'],
        }),
      }),
    );
  });

  it('THE RULE: the rejected text appears nowhere in what gets recorded', () => {
    // The one absolute constraint on this control. Asserted by serialising the
    // whole audit payload rather than by inspecting the fields we happen to
    // know about — a future field that carried content would fail this.
    const { guard, audit } = harness({ body: ['question'] });
    const req = request({
      body: { question: `patient name: Sara, id ${SECRET}, mobile 0551234567` },
    });

    expect(() => guard.canActivate(contextFor(req))).toThrow();

    const recorded = JSON.stringify(audit.record.mock.calls[0][0]);
    expect(recorded).not.toContain(SECRET);
    expect(recorded).not.toContain('Sara');
    expect(recorded).not.toContain('0551234567');
  });

  it('breaks the count down by category, so a false-positive pattern is identifiable', () => {
    const { guard, audit } = harness({ body: ['question'] });
    const req = request({
      body: { question: `patient name: Sara, id ${SECRET}, mobile 0551234567` },
    });

    expect(() => guard.canActivate(contextFor(req))).toThrow();
    expect(audit.record.mock.calls[0][0].metadata.categories).toEqual([
      'IDENTIFYING_CONTEXT',
      'NATIONAL_ID',
      'PHONE',
    ]);
  });

  it('records once per request even when several screened fields are dirty', () => {
    const { guard, audit } = harness({ body: ['title', 'description'] });
    const req = request({
      body: { title: SECRET, description: `also ${SECRET}` },
    });

    expect(() => guard.canActivate(contextFor(req))).toThrow();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('PhiScreenGuard — the query string', () => {
  it('screens query parameters, which is what /rag/search needs', () => {
    // GET /rag/search?q= carries free text in the URL, and the exception
    // filter logs req.url on a 5xx — the one route by which a question could
    // reach the application log.
    const { guard, audit } = harness({ query: ['q'] });
    const req = request({
      route: { path: '/rag/search' },
      query: { q: `records for ${SECRET}` },
    });

    expect(() => guard.canActivate(contextFor(req))).toThrow(BadRequestException);
    expect(audit.record.mock.calls[0][0].metadata.route).toBe('/rag/search');
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain(SECRET);
  });
});

describe('PhiScreenGuard — profiles', () => {
  const changeNote = 'supersedes the 2019-03-01 edition';

  it('lets an edition date through a METADATA field', () => {
    const { guard } = harness({
      body: ['changeNote'],
      profile: PhiProfile.METADATA,
    });
    expect(
      guard.canActivate(contextFor(request({ body: { changeNote } }))),
    ).toBe(true);
  });

  it('but rejects the same date in a clinical question', () => {
    const { guard } = harness({ body: ['question'] });
    expect(() =>
      guard.canActivate(contextFor(request({ body: { question: changeNote } }))),
    ).toThrow(BadRequestException);
  });

  it('still rejects an identifier in a METADATA field', () => {
    const { guard } = harness({
      body: ['changeNote'],
      profile: PhiProfile.METADATA,
    });
    expect(() =>
      guard.canActivate(
        contextFor(request({ body: { changeNote: `uploaded for ${SECRET}` } })),
      ),
    ).toThrow(BadRequestException);
  });
});

describe('PhiScreenGuard — the configurable MRN pattern', () => {
  afterEach(() => {
    delete process.env.PHI_MRN_PATTERN;
  });

  it('is inert when PHI_MRN_PATTERN is unset — the shipped state', () => {
    const { guard, audit } = harness({ body: ['question'] });
    expect(
      guard.canActivate(contextFor(request({ body: { question: 'record MR-004471' } }))),
    ).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('and the other patterns keep working while it is off', () => {
    const { guard } = harness({ body: ['question'] });
    expect(() =>
      guard.canActivate(contextFor(request({ body: { question: SECRET } }))),
    ).toThrow(BadRequestException);
  });

  it('turns on by setting the variable, with no code change', () => {
    process.env.PHI_MRN_PATTERN = '\\bMR-[0-9]{6}\\b';
    const { guard, audit } = harness({ body: ['question'] });

    expect(() =>
      guard.canActivate(contextFor(request({ body: { question: 'record MR-004471' } }))),
    ).toThrow(BadRequestException);
    expect(audit.record.mock.calls[0][0].metadata.categories).toEqual(['MRN']);
  });

  it('refuses to run on a malformed pattern instead of screening nothing', () => {
    // A broken regex must be loud. Silently falling back to "no MRN check"
    // would disable a control on a typo.
    process.env.PHI_MRN_PATTERN = '[unclosed';
    const { guard } = harness({ body: ['question'] });
    expect(() =>
      guard.canActivate(contextFor(request({ body: { question: 'anything' } }))),
    ).toThrow(/PHI_MRN_PATTERN is not a valid regular expression/);
  });
});
