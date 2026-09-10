import { PhiCategory, PhiProfile, scanForPhi } from '@bnp/shared';

/**
 * Coverage for the PHI pattern set (`packages/shared/src/phi.ts`).
 *
 * It lives in the API suite because `packages/shared` has no jest project of
 * its own; the module under test is the shared one, imported the same way
 * production imports it.
 *
 * The negative half is not a formality — it is the half that decides whether
 * this control survives contact with a ward. A screen that rejects "جرعة 10
 * مج" gets reported as broken on day one and switched off by the end of the
 * week, at which point the platform has no screen at all. So the false-positive
 * cases are asserted as hard as the true positives.
 */

const mrn = /\bMR-[0-9]{6}\b/;

describe('PHI scanner — identifiers are caught', () => {
  it.each([
    ['Saudi national ID', 'هل يمكن إعطاء الدواء للمريض 1098765432 ؟', PhiCategory.NATIONAL_ID],
    ['Iqama (leading 2)', 'check record for 2345678901 please', PhiCategory.NATIONAL_ID],
    ['local mobile', 'call the family on 0551234567', PhiCategory.PHONE],
    ['international mobile', 'contact +966551234567', PhiCategory.PHONE],
    ['00-prefixed mobile', 'contact 00966551234567', PhiCategory.PHONE],
    ['date of birth, day first', 'born 03/11/1984, weighs 60 kg', PhiCategory.DATE_OF_BIRTH],
    ['date of birth, ISO order', 'DOB 1984-11-03', PhiCategory.DATE_OF_BIRTH],
    ['date of birth, dotted', 'd.o.b 3.11.1984', PhiCategory.DATE_OF_BIRTH],
    ['Arabic identifying phrase', 'اسم المريض أحمد، ما الجرعة؟', PhiCategory.IDENTIFYING_CONTEXT],
    ['Arabic file number', 'رقم الملف 4471', PhiCategory.IDENTIFYING_CONTEXT],
    ['English identifying phrase', 'patient name: Sara', PhiCategory.IDENTIFYING_CONTEXT],
    ['MRN keyword', 'MRN 88213 — what dose?', PhiCategory.IDENTIFYING_CONTEXT],
  ])('catches %s', (_label, text, category) => {
    expect(scanForPhi(text)).toContain(category);
  });

  it('folds Arabic-Indic digits, so switching keyboards is not a bypass', () => {
    // Same national ID as the ASCII case above, typed on an Arabic keypad.
    expect(scanForPhi('المريض ١٠٩٨٧٦٥٤٣٢')).toContain(PhiCategory.NATIONAL_ID);
    expect(scanForPhi('اتصل على ۰۵۵۱۲۳٤٥٦۷')).toContain(PhiCategory.PHONE);
  });

  it('reports every category present, not just the first', () => {
    const found = scanForPhi('patient name: Sara, id 1098765432, mobile 0551234567');
    expect(found).toEqual(
      expect.arrayContaining([
        PhiCategory.NATIONAL_ID,
        PhiCategory.PHONE,
        PhiCategory.IDENTIFYING_CONTEXT,
      ]),
    );
  });
});

describe('PHI scanner — legitimate clinical text is left alone', () => {
  // The cases that matter most. Each one is something a nurse would actually
  // type; a hit on any of them is a defect, not a tuning question.
  it.each([
    ['a dose in mg', 'جرعة 10 مج للبالغين'],
    ['a volume in mL', 'هل 1000 مل صحيحة؟'],
    ['a frequency', '5 مل كل 8 ساعات'],
    ['a batch number not starting 1 or 2', 'batch 9087654321 expired?'],
    ['the paracetamol gold-set question', 'What intravenous paracetamol dose per kilogram is used for a patient weighing 50 kg or less?'],
    // The regression: `patient id` used to match the prefix of "patient
    // identifiers" and rejected this, a gold-set question about the two-
    // identifier medication-safety rule. The full gold set is asserted against
    // the live screen in test/phi-screening.e2e-spec.ts.
    ['the two-identifier safety question', 'Which two patient identifiers must be checked before administering a medication?'],
    ['a question about the records policy', 'what does the medical records policy say about retention?'],
    ['a plural patient phrase', 'how many patient names appear on the MAR?'],
    ['a max daily dose', 'paracetamol 15 mg/kg per dose, max 4000 mg/day'],
    ['a bare small number', 'give 2 mL slowly'],
    ['a concentration', 'KCl above 0.4 mEq/mL needs an independent double check'],
    ['a policy code', 'what does NUR-POL-012 say about hand hygiene?'],
    ['a frequency abbreviation', 'is q6h correct for a 70 kg adult?'],
    ['a duration range', 'rub for 20-30 seconds, wash for 40-60 seconds'],
    ['a year on its own', 'was the 2019 edition superseded?'],
    ['a partial date', 'review every 2 years per MM-7'],
    ['an Arabic clinical question with numbers', 'ما جرعة الباراسيتامول الوريدي لمريض وزنه 70 كجم مع حد أقصى 4000 مج يومياً؟'],
  ])('does not fire on %s', (_label, text) => {
    expect(scanForPhi(text)).toEqual([]);
  });

  it('does not fire on the bare word "patient", which is in almost every real question', () => {
    expect(scanForPhi('what is the maximum dose for an adult patient?')).toEqual([]);
    expect(scanForPhi('ما الجرعة القصوى للمريض البالغ؟')).toEqual([]);
  });

  it('does not treat a ten-digit window inside a longer number as an ID', () => {
    expect(scanForPhi('reference 1234567890123')).toEqual([]);
  });

  it('KNOWN FALSE POSITIVE: a ten-digit batch number starting with 1 or 2', () => {
    // Documented in SECURITY.md and accepted. Removing it needs the hospital's
    // real identifier format, which the platform does not have; widening the
    // rule to "any ten digits" would trade this for a much worse one. Pinned
    // as a test so the trade-off is a decision on record, not a surprise.
    expect(scanForPhi('batch 1987654321 expired?')).toContain(PhiCategory.NATIONAL_ID);
  });
});

describe('PHI scanner — the METADATA profile', () => {
  it('still catches identifiers in document metadata', () => {
    expect(scanForPhi('uploaded for 1098765432', { profile: PhiProfile.METADATA })).toContain(
      PhiCategory.NATIONAL_ID,
    );
    expect(scanForPhi('contact 0551234567', { profile: PhiProfile.METADATA })).toContain(
      PhiCategory.PHONE,
    );
  });

  it('allows the dates and names that governance text legitimately carries', () => {
    // These are what a change note or an approval comment is *for*. Under the
    // FREE_TEXT profile they would be rejected, which is why the profile split
    // exists rather than one setting for every field.
    const changeNote = 'supersedes the 2019-03-01 edition; approved per Dr. Ali';
    expect(scanForPhi(changeNote, { profile: PhiProfile.METADATA })).toEqual([]);
    expect(scanForPhi(changeNote)).toContain(PhiCategory.DATE_OF_BIRTH);
  });
});

describe('PHI scanner — the MRN pattern is off until it is configured', () => {
  it('does not run at all when no pattern is supplied', () => {
    // The shipped state. The platform has no institutional MRN format, and a
    // guessed one would be worse than none.
    expect(scanForPhi('record MR-004471 attached')).toEqual([]);
    expect(scanForPhi('record MR-004471 attached', { mrnPattern: null })).toEqual([]);
  });

  it('the other four patterns stay active while it is off', () => {
    expect(scanForPhi('id 1098765432', { mrnPattern: null })).toEqual([
      PhiCategory.NATIONAL_ID,
    ]);
  });

  it('catches the hospital format once one is supplied', () => {
    expect(scanForPhi('record MR-004471 attached', { mrnPattern: mrn })).toEqual([
      PhiCategory.MRN,
    ]);
  });

  it('applies under the METADATA profile too', () => {
    expect(
      scanForPhi('MR-004471', { profile: PhiProfile.METADATA, mrnPattern: mrn }),
    ).toEqual([PhiCategory.MRN]);
  });
});

describe('PHI scanner — degenerate input', () => {
  it.each([['empty', ''], ['whitespace', '   ']])('is clear for %s', (_l, text) => {
    expect(scanForPhi(text)).toEqual([]);
  });

  it('never returns any part of the text it inspected', () => {
    // The load-bearing property of this module: its return type cannot carry
    // content, so no caller can accidentally persist it.
    const found = scanForPhi('patient name: Sara, id 1098765432');
    for (const category of found) {
      expect(Object.values(PhiCategory)).toContain(category);
    }
  });
});
