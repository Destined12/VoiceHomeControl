import { BASE_CUSTOM_VOCABULARY } from './vocabulary';

export type TranscriptionConfig = {
  languageCodes: string[];
  customVocabulary: string[];
};

// BCP-47 hint for speech recognition. `gemini-3.5-transcribe-live` supports
// en-GB, en-IN and en-US (there is no en-NG), so Nigerian-accented English is
// biased toward British English, the reference variety used in Nigeria.
export const TRANSCRIBE_LANGUAGE_CODES = ['en-GB'];

// `BASE_CUSTOM_VOCABULARY` lives in `lib/vocabulary.ts` so the synonym table
// stays the single source of truth. Room-specific vocabulary (device names,
// room names and aliases) is appended at token creation time from the database.
export { BASE_CUSTOM_VOCABULARY };

// Best results are typically seen with up to ~100 terms; the synonym table
// needs a little more headroom.
const MAX_VOCABULARY_TERMS = 150;

export function buildCustomVocabulary(extra: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...BASE_CUSTOM_VOCABULARY, ...extra]) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_VOCABULARY_TERMS) break;
  }
  return out;
}

export function buildTranscriptionConfig(extra: string[] = []): TranscriptionConfig {
  return {
    languageCodes: TRANSCRIBE_LANGUAGE_CODES,
    customVocabulary: buildCustomVocabulary(extra),
  };
}
