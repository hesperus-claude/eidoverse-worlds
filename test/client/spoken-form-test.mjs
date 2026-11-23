// spoken-form — what the larynx gets. Table-driven, executable.
import { spokenForm, ttsChunks } from '../../client/lib/audio/tts-chunk.js';
import { suite } from '../gate/suite.ts';
const S = suite('spoken-form');
const t = (name, got, want) => S.check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
t('``` fenced code never speaks', spokenForm('before ```js\nconst x = 1;\n``` after'), 'before after');
t('a ~~~ fence never speaks either', spokenForm('before ~~~py\nx = 1\n~~~ after'), 'before after');
t('unterminated fence drops to end', spokenForm('look: ```raw dump of everything'), 'look:');
t('bare URL becomes link', spokenForm('grab https://a-b.trycloudflare.com/?k=v&x=1 now'), 'grab link now');
t('markdown link keeps its label', spokenForm('see [the runbook](https://x.y/z) here'), 'see the runbook here');
t('world:staging pauses instead of naming the colon', spokenForm('join world:staging'), 'join world, staging');
t('times keep their colon', spokenForm('at 6:04 sharp'), 'at 6:04 sharp');
t('arrows become pauses', spokenForm('a -> b => c'), 'a , b , c');
t('bullets become pauses', spokenForm('x · y • z'), 'x , y , z');
t('emphasis + emoji still stripped', spokenForm('*hello* 🌒 **there**'), 'hello there');
t('spaced colon untouched (prosodic already)', spokenForm('one thing: the gate'), 'one thing: the gate');
// end-to-end: chunks of a fenced-only message = nothing to say
t('fence-only utterance is silent', JSON.stringify(ttsChunks('```\nlogs\n```')), '[]');
// a skin tone rides its emoji: dropped with it, so a toned emoji alone says nothing either
t('a skin-toned emoji is stripped whole', spokenForm('nice 👍🏽 work'), 'nice work');
t('a toned-emoji-only utterance is silent', JSON.stringify(ttsChunks('👍🏽')), '[]');
// a flag is two regional-indicator letters (piper spells them); a keycap's U+20E3 and a subdivision flag's tag chars are named too
t('a flag is stripped whole', spokenForm('go 🇫🇷 team'), 'go team');
t('a keycap keeps its digit, not the keycap mark', spokenForm('step 1\uFE0F\u20E3 now'), 'step 1 now');
t('a tag-sequence flag is stripped whole', spokenForm('hi 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} there'), 'hi there');
S.done();
