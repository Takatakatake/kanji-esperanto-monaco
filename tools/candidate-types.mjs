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
