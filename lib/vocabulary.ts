export type VocabularyRow = {
  term: string;
  synonyms: string[];
};

// Single source of truth for the synonym table. Each entry maps a canonical
// term to the phrases that should be treated as equivalent when both biasing
// speech recognition and resolving spoken commands.
export const VOCABULARY_ROWS: VocabularyRow[] = [
  {
    term: 'sitting room bulb',
    synonyms: ['sitting room light', 'lounge bulb', 'lounge light'],
  },
  {
    term: 'sitting room socket',
    synonyms: ['lounge socket', 'sitting room plug', 'living room socket'],
  },
  {
    term: 'master bedroom bulb',
    synonyms: ['master bedroom light', 'main bedroom bulb', 'bedroom light'],
  },
  {
    term: 'master bedroom socket',
    synonyms: ['master bedroom plug', 'main bedroom socket', 'bedroom socket'],
  },
  {
    term: 'bulb',
    synonyms: ['light bulb', 'lamp', 'light'],
  },
  {
    term: 'socket',
    synonyms: ['plug socket', 'power socket', 'power point'],
  },
  {
    term: 'sitting room',
    synonyms: ['lounge', 'living room', 'sitting area'],
  },
  {
    term: 'master bedroom',
    synonyms: ['main bedroom', 'principal bedroom', 'main sleeping room'],
  },
  {
    term: 'turn on',
    synonyms: ['switch on', 'put on', 'power on'],
  },
  {
    term: 'turn off',
    synonyms: ['switch off', 'put off', 'power off'],
  },
  {
    term: 'activate',
    synonyms: ['enable', 'start', 'switch on'],
  },
  {
    term: 'deactivate',
    synonyms: ['disable', 'stop', 'switch off'],
  },
  {
    term: 'light on',
    synonyms: ['bulb on', 'lighting on', 'illuminate'],
  },
  {
    term: 'light off',
    synonyms: ['bulb off', 'lighting off', 'extinguish'],
  },
  {
    term: 'socket on',
    synonyms: ['plug on', 'power on', 'energise socket'],
  },
  {
    term: 'socket off',
    synonyms: ['plug off', 'power off', 'disconnect socket'],
  },
  {
    term: 'switch',
    synonyms: ['light switch', 'power switch', 'electrical switch'],
  },
  {
    term: 'control',
    synonyms: ['operate', 'manage', 'activate'],
  },
  {
    term: 'please turn on',
    synonyms: ['could you switch on', 'kindly put on', 'turn on please'],
  },
  {
    term: 'please turn off',
    synonyms: ['could you switch off', 'kindly put off', 'turn off please'],
  },
];

// Generic terms retained from the original vocabulary that are not part of the
// synonym table above.
const EXTRA_BASE_TERMS = [
  'outlet',
  'study room',
  'kitchen',
  'bathroom',
  'toilet',
  'corridor',
  'store',
];

// Flattened, de-duplicated vocabulary used to bias speech recognition. Room or
// device-specific terms are appended at token creation time from the database.
export const BASE_CUSTOM_VOCABULARY: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const row of VOCABULARY_ROWS) {
    push(row.term);
    row.synonyms.forEach(push);
  }
  EXTRA_BASE_TERMS.forEach(push);
  return out;
})();

const CANONICAL_TERMS = new Set(VOCABULARY_ROWS.map(row => row.term.toLowerCase()));

// lowercase synonym -> lowercase canonical term. Canonical terms always win, so
// a synonym that is itself another row's term (e.g. "activate") is not remapped.
const CANONICAL_MAP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const row of VOCABULARY_ROWS) {
    const canonical = row.term.toLowerCase();
    for (const synonym of row.synonyms) {
      const key = synonym.trim().toLowerCase();
      if (!key || key === canonical) continue;
      if (CANONICAL_TERMS.has(key)) continue;
      if (map.has(key)) continue;
      map.set(key, canonical);
    }
  }
  return map;
})();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest phrases first so multi-word synonyms win over their substrings.
const CANONICAL_PATTERN = new RegExp(
  '\\b(' +
    [...CANONICAL_MAP.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|') +
    ')\\b',
  'g'
);

// Rewrites a spoken phrase into canonical terms, e.g.
// "turn on the lounge light" -> "turn on the sitting room bulb".
export function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(CANONICAL_PATTERN, match => CANONICAL_MAP.get(match) ?? match);
}
