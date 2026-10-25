/**
 * The mod speaks the language set in Claude Code (`language` in settings.json,
 * free text such as "italian" or "it"). Languages it has no words for fall
 * back to English.
 */
export type Words = {
  title: string;
  context: (percent: number) => string;
  noData: string;
  auto: (percent: number) => string;
  button: string;
  busy: string;
  kept: (cut: string) => string;
  summary: string;
  unavailable: string;
  barAlt: (percent: number | null, auto: number) => string;
};

const en: Words = {
  title: 'Compact',
  context: (p) => `Context ${p}%`,
  noData: 'Context: no reading yet',
  auto: (p) => `Auto-compact at ${p}%`,
  button: 'Compact',
  busy: 'Compacting…',
  kept: (cut) => `Compacted without a summary: −${cut}`,
  summary: 'Compacted with the built-in summary',
  unavailable: 'Compaction is not available here',
  barAlt: (p, a) => `Context ${p ?? '?'}% full, auto-compact at ${a}%`,
};

const it: Words = {
  title: 'Compatta',
  context: (p) => `Contesto ${p}%`,
  noData: 'Contesto: ancora nessuna lettura',
  auto: (p) => `Compattazione automatica al ${p}%`,
  button: 'Compatta',
  busy: 'Compattazione…',
  kept: (cut) => `Compattata senza riassunto: −${cut}`,
  summary: 'Compattata con il riassunto standard',
  unavailable: 'La compattazione qui non è disponibile',
  barAlt: (p, a) => `Contesto pieno al ${p ?? '?'}%, compattazione automatica al ${a}%`,
};

const es: Words = {
  title: 'Compactar',
  context: (p) => `Contexto ${p}%`,
  noData: 'Contexto: aún sin lectura',
  auto: (p) => `Compactación automática al ${p}%`,
  button: 'Compactar',
  busy: 'Compactando…',
  kept: (cut) => `Compactado sin resumen: −${cut}`,
  summary: 'Compactado con el resumen estándar',
  unavailable: 'La compactación no está disponible aquí',
  barAlt: (p, a) => `Contexto al ${p ?? '?'}%, compactación automática al ${a}%`,
};

const fr: Words = {
  title: 'Compacter',
  context: (p) => `Contexte ${p} %`,
  noData: 'Contexte : pas encore de mesure',
  auto: (p) => `Compactage automatique à ${p} %`,
  button: 'Compacter',
  busy: 'Compactage…',
  kept: (cut) => `Compacté sans résumé : −${cut}`,
  summary: 'Compacté avec le résumé standard',
  unavailable: 'Le compactage n’est pas disponible ici',
  barAlt: (p, a) => `Contexte rempli à ${p ?? '?'} %, compactage automatique à ${a} %`,
};

const de: Words = {
  title: 'Kompaktieren',
  context: (p) => `Kontext ${p} %`,
  noData: 'Kontext: noch kein Wert',
  auto: (p) => `Automatisch kompaktieren bei ${p} %`,
  button: 'Kompaktieren',
  busy: 'Wird kompaktiert…',
  kept: (cut) => `Ohne Zusammenfassung kompaktiert: −${cut}`,
  summary: 'Mit der Standardzusammenfassung kompaktiert',
  unavailable: 'Kompaktieren ist hier nicht verfügbar',
  barAlt: (p, a) => `Kontext zu ${p ?? '?'} % gefüllt, automatisch kompaktieren bei ${a} %`,
};

const pt: Words = {
  title: 'Compactar',
  context: (p) => `Contexto ${p}%`,
  noData: 'Contexto: ainda sem leitura',
  auto: (p) => `Compactação automática a ${p}%`,
  button: 'Compactar',
  busy: 'Compactando…',
  kept: (cut) => `Compactado sem resumo: −${cut}`,
  summary: 'Compactado com o resumo padrão',
  unavailable: 'A compactação não está disponível aqui',
  barAlt: (p, a) => `Contexto a ${p ?? '?'}%, compactação automática a ${a}%`,
};

const LANGUAGES: readonly [RegExp, Words][] = [
  [/^(it|ital)/, it],
  [/^(es|span|espa|castell)/, es],
  [/^(fr|fran)/, fr],
  [/^(de|germ|deut)/, de],
  [/^(pt|portu)/, pt],
];

/** The words for a `language` setting; English when unset or unknown. */
export function wordsFor(language: unknown): Words {
  if (typeof language !== 'string') return en;
  const name = language.trim().toLowerCase();
  for (const [pattern, words] of LANGUAGES) if (pattern.test(name)) return words;
  return en;
}
