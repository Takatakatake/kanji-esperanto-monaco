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
// The first three alternatives are a VERBATIM copy of the master's gate in `_inject_final.ps1`.
// The fourth covers rows the master keeps as a RECORD of a settled ruling: it neutralises the
// injection but leaves the kanji in place, then states in the note that the row is not permission
// to use it ("笔を実現してよいという記録ではない。再提案不要"). Those rulings are the user's own
// (plum→羽 統一 / sinus→洞ˢ 統一), so offering the retracted form as a candidate contradicts a
// decision that has already been made.
//
// EVERY addition here must be a PROHIBITION, never a category description, and must be verified
// against the whole ledger first. Measured on the 197-row table of master f1cc2a7:
//   使用禁止 / 実現禁止 / 撤回・封印               → 1 row  (kuri 居ᴷ)          ✅ intended
//   実現してよいという記録ではない                  → 2 rows (plum 笔ᴾᴸ, sinus 弦ˢ) ✅ intended
// and the tempting-but-wrong candidates, all of which hit LIVE rows:
//   注入非適用の履歴記録 — describes what an `amb` row IS; would kill every amb row if the
//                          master ever writes it generally
//   据置               — 5 rows, 3 of them live (aŭt 自ᴬ, arke 菌ᴬᴷ, on 叔ᴼᴺ)
//   撤回 (alone)        — 3 rows, including the live `sol → 胶ˢ`, whose note merely explains
//                          that some OTHER form was retracted
// A false negative (shipping something the master did not want) is visible and fixable; a false
// positive silently removes working candidates for every user. Prefer precision.
export const SEALED_NOTE = /使用禁止|実現禁止|撤回・封印|実現してよいという記録ではない/;
