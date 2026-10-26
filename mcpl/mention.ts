/** A trailing ` (qualifier)` on a name (`#name (Guild)`, `Artie (kube)`): the part people drop when addressing
 *  it. Only a final parenthetical counts. */
const TRAILING_QUALIFIER = /\s*\([^()]*\)\s*$/u;

/** "Was I named?" over a body's id and token display name, each also qualifier-dropped. Names arrive unvalidated
 *  from tokens.json: non-strings skipped, escaped, matched with lookarounds, not \b (no boundary after punctuation).
 *  Whole handles only (a hyphen is part of one); a shared first name addresses both bodies. Short forms refuse a
 *  trailing parenthetical; self-enrolled names pass dropQualifiers:false. null if no usable name. */
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
