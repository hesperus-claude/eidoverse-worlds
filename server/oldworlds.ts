// Worlds saved in an old format, found and named; a directory holding an old log is never opened. Instead:
//   - the OPERATOR is told at boot, one block per world, with the exact command (bootNotice);
//   - a VISITOR is told in plain words that the world is safe and needs a one-time conversion (visitorText).
// Two kinds, never confused:
//   translatable  first-protocol log.jsonl: tools/protocol/world.ts translate <name>, in place (old log kept, never
//                 written, as log.original.jsonl);
//   pre-names     saved before the names pass (livehost isPreNamesDir): re-translated from its ORIGINAL log, or refounded.
// Pure reads of the directory: nothing here writes, and nothing here loads the translator.
import fs from "node:fs";
import path from "node:path";
import { isWorldDir, isPreNamesDir } from "./livehost.ts";
import { WORLD_NAME_RE } from "./limits.ts";

export type OldWorldKind = "translatable" | "pre-names";
export type OldWorld = {
  name: string;
  kind: OldWorldKind;
  /** absolute */
  file: string;
  /** free on disk: a pre-names world's re-translation goes there */
  suggestedName: string;
  /** the dry run: report and hash, nothing written */
  command: string;
  /** bound to the approved report hash, on the operator's countersignature alone (no owner can be attested) */
  approve: string;
  /** pre-names only, when its original log is gone */
  refound?: string;
  /** plain words, no command line */
  visitor: string;
};

/** The 4005 refusal (server.ts): a NATIVE session has no page to reload, so it's told it isn't ported yet. */
export function noFoldRefusal(world: string, native: boolean): string {
  return native
    ? `"${world}" is a world of the current protocol, and the Unreal client hasn't been ported to it yet: it doesn't fold the world's log, so it can't join. Nothing is wrong with your sign-in or with the world; a browser client can join it now, and the Unreal client will when its port lands.`
    : `"${world}" needs a client that folds its log, and this one doesn't — reload the page for the current client, or update the agent`;
}

const TOOL = "bun tools/protocol/world.ts";
export const HASH_PLACEHOLDER = "<the report hash the dry run printed>";
const APPROVAL = "The dry run writes nothing: it prints what the translation would do (what is dropped by design, what it would refuse) and the report's hash. Read it; then translate it, bound to that hash:";
const KEPT_IN_PLACE = "It keeps its name, so links to it keep working; the original log is kept untouched beside it as log.original.jsonl.";
const KEPT = "the original log is kept untouched; translate into a new name, then point links at it (or rename the directories)";

/** single-quoted when it holds spaces or quotes */
export const shellWord = (s: string): string => (/^[\w/.,:@%+=~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `<name>-2`, `-3`, …; an empty directory counts as taken. */
function freeName(dir: string, name: string): string {
  for (let k = 2; ; k++) {
    const tail = `-${k}`;
    const cand = name.slice(0, 64 - tail.length) + tail;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
}

export function visitorText(name: string, kind: OldWorldKind): string {
  return kind === "translatable"
    ? `"${name}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost — the world's log is kept as it was.`
    : `"${name}" was saved while this version of Eidoverse was still settling its names, and whoever runs this server needs to convert it again before it can open. Nothing is lost — the world's saved log is kept as it was.`;
}

/** null for a current world, an empty directory, or a missing one. */
export function oldWorldAt(dir: string, name: string): OldWorld | null {
  if (!WORLD_NAME_RE.test(name)) return null;
  const d = path.join(dir, name);
  let st: fs.Stats; try { st = fs.statSync(d); } catch { return null; }
  if (!st.isDirectory() || isWorldDir(d)) return null;
  const suggestedName = freeName(dir, name);
  const head = `WORLDS_DIR=${shellWord(dir)} ${TOOL}`;
  if (isPreNamesDir(d)) {   // checked first: such a log may be named log.jsonl too (an older file name)
    const file = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort((a, b) => (a === "world.jsonl" ? -1 : b === "world.jsonl" ? 1 : a.localeCompare(b)))[0]!;
    return { name, kind: "pre-names", file: path.join(d, file), suggestedName,
      command: `${head} translate <its-original-old-world> ${suggestedName} --dry-run --no-founder-key`,
      approve: `${head} translate <its-original-old-world> ${suggestedName} --no-founder-key --approved ${HASH_PLACEHOLDER} --operator-only-no-owner`,
      refound: `${head} found ${suggestedName} --owner <your id>`, visitor: visitorText(name, "pre-names") };
  }
  const file = path.join(d, "log.jsonl");
  if (!fs.existsSync(file)) return null;
  return { name, kind: "translatable", file, suggestedName,
    command: `${head} translate ${name} --dry-run --no-founder-key`,
    approve: `${head} translate ${name} --no-founder-key --approved ${HASH_PLACEHOLDER} --operator-only-no-owner`, visitor: visitorText(name, "translatable") };
}

export function oldWorldsIn(dir: string): OldWorld[] {
  let names: string[]; try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  return names.map((n) => oldWorldAt(dir, n)).filter((o): o is OldWorld => !!o);
}

/** One block per world and a summary line; "" when there are none. */
export function bootNotice(dir: string): string {
  const old = oldWorldsIn(dir);
  if (!old.length) return "";
  const blocks = old.map((o) => {
    const at = path.relative(dir, o.file).split(path.sep).join("/");
    return o.kind === "translatable"
      ? [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved by an older version of Eidoverse (a log.jsonl of the first protocol). Translate it once, in place. First the dry run:`,
         `    ${o.command}`,
         `  ${APPROVAL}`,
         `    ${o.approve}`,
         `  A translation names no founder: nothing can yet bind a key to the old world's owner (an old-format log records accounts, not keys), so the world's top governance tier (tier 0) stays empty, the operator's countersignature is the only signature, and the record says no owner was attested.`,
         `  ${KEPT_IN_PLACE}`].join("\n")
      : [`[boot] old-format world "${o.name}" (${at}) is NOT being served.`,
         `  It was saved before this server's protocol names changed (2026-10-07), so it can't be translated as it stands. Re-translate it from its original old log (the directory its first-protocol log.jsonl is in) into a new world. First the dry run:`,
         `    ${o.command}`,
         `  ${APPROVAL}`,
         `    ${o.approve}`,
         `  or, if that original is gone, refound it empty:`,
         `    ${o.refound}`,
         `  ${KEPT}`].join("\n");
  });
  return `${blocks.join("\n")}\n[boot] ${old.length} world(s) need translating — see above`;
}
