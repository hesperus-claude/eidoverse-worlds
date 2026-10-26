/** A trailing ` (qualifier)` on a name, the house label convention
 *  (`#name (Guild)`, `Artie (kube)`): the part people drop when they address
 *  the thing. Only a final parenthetical counts; nothing inside the name moves. */
const TRAILING_QUALIFIER = /\s*\([^()]*\)\s*$/u;

/** The "was I named?" pattern over every name a body answers to: its id and token display name, each also
 *  qualifier-dropped. Names arrive unvalidated from tokens.json: non-strings are skipped, names are escaped, and
 *  matching uses lookarounds, not \b (no boundary after punctuation). Whole handles only (a hyphen is part of one);
 *  a shared first name addresses both bodies. Short forms of a qualified name refuse a trailing parenthetical;
 *  self-enrolled names pass dropQualifiers:false. null if no usable name. */
export function mentionRegexFor(names: readonly unknown[], { dropQualifiers = true }: { dropQualifiers?: boolean } = {}): RegExp | null {
  // keyed by lower case, first spelling kept (the id): `i` without `u` doesn't fold every pair toLowerCase() does
  const forms = new Map<string, string>();   // lower-cased form -> the form
  const shorts = new Set<string>();          // short forms of the qualified names
  for (const candidate of names) {
    if (typeof candidate !== "string" || !candidate) continue;
    if (!forms.has(candidate.toLowerCase())) forms.set(candidate.toLowerCase(), candidate);
    const short = candidate.replace(TRAILING_QUALIFIER, "");
    if (!short || short === candidate) continue;
    shorts.add(short.toLowerCase());
    if (dropQualifiers && !forms.has(short.toLowerCase())) forms.set(short.toLowerCase(), short);
  }
  if (forms.size === 0) return null;
  const parts = [...forms].map(([key, form]) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + (shorts.has(key) ? "(?!\\s*\\([^()]*\\))" : ""));
  return new RegExp(`(?<![\\w@-])@?(?:${parts.join("|")})(?![\\w-])`, "i");
}
