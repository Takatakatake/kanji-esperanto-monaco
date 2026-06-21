// Normalize an Esperanto root to x-system ASCII (ĉ->cx, g^->gx, …), lowercased.
// Shared by the build tools so the rule lives in exactly one place.
export function toXSystem(input) {
  return String(input || '')
    .trim()
    .normalize('NFC')
    .replace(/([cghjsuCGHJSU])\^/g, (_m, ch) => ch.toLowerCase() + 'x')
    .replace(/[ĉĈ]/g, 'cx')
    .replace(/[ĝĜ]/g, 'gx')
    .replace(/[ĥĤ]/g, 'hx')
    .replace(/[ĵĴ]/g, 'jx')
    .replace(/[ŝŜ]/g, 'sx')
    .replace(/[ŭŬ]/g, 'ux')
    .toLowerCase();
}
