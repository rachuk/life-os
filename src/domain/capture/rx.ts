/**
 * JS `\b` and `\w` are ASCII-only, so they silently fail on Cyrillic text.
 * `rx()` rewrites them into Unicode-aware equivalents and adds the `u` flag.
 */
const W = String.raw`[\p{L}\p{N}_']`;
const BOUNDARY = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

export function rx(source: string, flags = ''): RegExp {
  const converted = source.replace(/\\b/g, BOUNDARY).replace(/\\w/g, W);
  return new RegExp(converted, flags.includes('u') ? flags : flags + 'u');
}
