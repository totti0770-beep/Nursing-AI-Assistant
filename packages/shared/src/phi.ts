/**
 * PHI screening — patterns and a pure scanner.
 *
 * This module never sees a database, a request or a logger, and it never
 * returns any part of the text it inspected. That is deliberate: the one
 * absolute rule of this control is that rejected text is not written anywhere,
 * so the component that recognises it must be structurally incapable of
 * leaking it. It answers one question — *which categories of identifier does
 * this string contain* — and nothing else.
 *
 * Everything here is linear-time: no nested quantifiers, no backtracking
 * traps. The one exception is the operator-supplied MRN pattern, which is the
 * operator's responsibility (see SECURITY.md).
 */

export enum PhiCategory {
  /** Saudi national ID or Iqama number. */
  NATIONAL_ID = 'NATIONAL_ID',
  /** A full numeric date, which in a clinical question means a date of birth. */
  DATE_OF_BIRTH = 'DATE_OF_BIRTH',
  /** Saudi mobile number, local or international form. */
  PHONE = 'PHONE',
  /** An explicit identifying phrase carrying a value ("patient name: ...", "رقم الملف ..."). */
  IDENTIFYING_CONTEXT = 'IDENTIFYING_CONTEXT',
  /** Hospital medical-record number — only when PHI_MRN_PATTERN is configured. */
  MRN = 'MRN',
}

/**
 * How aggressively to screen a given field.
 *
 * `FREE_TEXT` is for fields a clinician types a question into. Nothing in that
 * field legitimately carries a person's identity, so every pattern applies.
 *
 * `METADATA` is for fields that describe a *document* — titles, descriptions,
 * change notes, approval comments, formula names. Identifiers are never
 * legitimate there either, but dates and names are: "supersedes the 2019-03-01
 * edition" and "per Dr. Ali's protocol" are exactly what those fields are for.
 * Running the full profile over them would fire on ordinary governance text,
 * and a control that blocks correct work is a control that gets switched off.
 * So `METADATA` keeps the identifier patterns and drops the two that depend on
 * context to be meaningful.
 */
export enum PhiProfile {
  FREE_TEXT = 'FREE_TEXT',
  METADATA = 'METADATA',
}

const METADATA_CATEGORIES: readonly PhiCategory[] = [
  PhiCategory.NATIONAL_ID,
  PhiCategory.PHONE,
  PhiCategory.MRN,
];

/**
 * Saudi national ID / Iqama: exactly ten digits beginning with 1 or 2.
 *
 * The leading-digit constraint is the whole point. "Any ten digits" would fire
 * on batch numbers, catalogue codes and long dose figures, and a rule that
 * blocks a legitimate clinical question is worse than no rule — it gets
 * disabled within a week. The digit lookarounds (rather than \b) stop it
 * matching a ten-digit window inside a longer number.
 *
 * Known and accepted: a ten-digit batch number that happens to start with 1 or
 * 2 is a false positive. It cannot be removed without the hospital's real
 * identifier format; see PHI_MRN_PATTERN and SECURITY.md.
 */
const NATIONAL_ID = /(?<![0-9])[12][0-9]{9}(?![0-9])/;

/**
 * A complete numeric date in either order, with / - or . separators.
 * Requires day, month and a 19xx/20xx year — a bare "5/8" is a fraction or a
 * frequency, not a birth date.
 */
const DATE_OF_BIRTH =
  /(?<![0-9])(?:(?:0?[1-9]|[12][0-9]|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)[0-9]{2}|(?:19|20)[0-9]{2}[/.-](?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12][0-9]|3[01]))(?![0-9])/;

/** Saudi mobile: 05XXXXXXXX, +9665XXXXXXXX, 009665XXXXXXXX. */
const PHONE = /(?<![0-9])(?:(?:\+|00)966[\s-]?5[0-9]{8}|05[0-9]{8})(?![0-9])/;

/**
 * An identifying phrase followed by a value.
 *
 * The phrases are deliberately specific. Screening on the bare word "patient"
 * would reject the most ordinary question this platform exists to answer —
 * "what dose for a patient weighing 50 kg" — so only phrases that have no
 * legitimate use in a clinical question are listed, and each must actually
 * carry a value after it.
 *
 * The trailing \b on each English phrase is load-bearing, not tidiness.
 * Without it `patient\s+id` matches the *prefix* of "patient identifiers", and
 * "Which two patient identifiers must be checked before administering a
 * medication?" — a question straight out of the gold set, and one of the most
 * ordinary safety questions a nurse can ask — is rejected as PHI. Every
 * gold-set question is asserted against this pattern in
 * `test/phi-screening.e2e-spec.ts` for exactly that reason.
 */
const IDENTIFYING_CONTEXT =
  /(?:اسم\s+المريض(?:ة)?|هوية\s+المريض(?:ة)?|رقم\s+الملف|رقم\s+السجل|السجل\s+الطبي|رقم\s+الهوية|patient\s+name\b|patient\s+id\b|medical\s+record(?:\s+number)?\b|\bMRN\b|\bfile\s+(?:no|number)\b)\s*[:=#-]?\s*\S/iu;

const BUILT_IN: readonly [PhiCategory, RegExp][] = [
  [PhiCategory.NATIONAL_ID, NATIONAL_ID],
  [PhiCategory.DATE_OF_BIRTH, DATE_OF_BIRTH],
  [PhiCategory.PHONE, PHONE],
  [PhiCategory.IDENTIFYING_CONTEXT, IDENTIFYING_CONTEXT],
];

/**
 * Arabic-Indic and Extended Arabic-Indic digits fold to ASCII before matching.
 * The mobile app is Arabic-first, and a national ID typed as ١٢٣٤٥٦٧٨٩٠ is the
 * same identifier as 1234567890 — a screen that only understands ASCII digits
 * is trivially bypassed by switching keyboards.
 */
function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export interface PhiScanOptions {
  profile?: PhiProfile;
  /**
   * The hospital's medical-record-number pattern. `null`/omitted means the MRN
   * check does not run at all — the platform ships without a format for it.
   */
  mrnPattern?: RegExp | null;
}

/**
 * Returns the categories of identifier found, in a stable order. An empty
 * array means the text is clear.
 *
 * Every category present is reported, not just the first: the interception
 * counter is broken down by category, and a string carrying both an ID and a
 * phone number should count as both.
 */
export function scanForPhi(text: string, options: PhiScanOptions = {}): PhiCategory[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const profile = options.profile ?? PhiProfile.FREE_TEXT;
  const allowed =
    profile === PhiProfile.METADATA ? METADATA_CATEGORIES : null;
  const folded = foldDigits(text);

  const found: PhiCategory[] = [];
  for (const [category, pattern] of BUILT_IN) {
    if (allowed && !allowed.includes(category)) continue;
    if (pattern.test(folded)) found.push(category);
  }

  const mrn = options.mrnPattern;
  if (mrn && (!allowed || allowed.includes(PhiCategory.MRN)) && mrn.test(folded)) {
    found.push(PhiCategory.MRN);
  }

  return found;
}
