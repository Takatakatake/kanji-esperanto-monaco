// The `type` values a completion item can carry, shared by every merge/verify tool.
//
// They live in their own module because two independent merge steps need to know about each
// other's items: merge-homonym-alt.mjs must carry inline tokens through untouched (and keep
// them OUT of its priority baseline), while merge-inline-tokens.mjs ranks after the alternates.
// Importing the constants from each other would be a cycle; duplicating the string literals
// would drift. One tiny module owns them instead.
//
// Items with no `type` are the base senses built from the master's `_identifier_sidecar.tsv`.

// Curated homonym alternates from `_homonym_disp.tsv` (see merge-homonym-alt.mjs).
export const ALT_TYPES = new Set(['amb', 'sep', 'comb']);

// Tokens the master's injection layer writes inline from a line-level context rule, which
// therefore appear in NO root table (see merge-inline-tokens.mjs).
export const INLINE_TYPE = 'inline';

// A second sense the master has RETRACTED but deliberately left in the table.
//
// When a ruling is reversed the master does not delete the row — it keeps it as a record of the
// decision and neutralises it in place, blanking the sense field and marking the note. Its own
// injection builder throws on these markers rather than rendering them. We must refuse them for
// the same reason: `kuri → 居ᴷ` was withdrawn as a partial transliteration (a hard policy
// violation), yet the row still carries the kanji, so a tool that only reads the columns would
// happily offer it — labelled with the placeholder text, no less.
//
// The pattern is a VERBATIM copy of the master's gate in `_inject_final.ps1`. Do not "improve"
// it by matching 撤回 alone: active rows explain in prose that some OTHER form was retracted
// (the live `sol → 胶ˢ` row says exactly that), and a looser match would silently seal them.
export const SEALED_NOTE = /使用禁止|実現禁止|撤回・封印/;
