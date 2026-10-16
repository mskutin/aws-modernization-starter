/**
 * Glob matching with the same semantics GitLab uses for `rules:changes`:
 * Ruby `File.fnmatch?(pattern, path, FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB)`.
 *
 * - `*` matches within one path segment (never `/`), dotfiles included.
 * - `?` matches one character except `/`.
 * - `**` followed by `/` matches zero or more directories; `**` anywhere else acts like `*`.
 *   (So `dir/**` does NOT match `dir/a/b`; write `dir/**\/*`.)
 * - `[abc]`, `[!abc]`, `[^abc]` character classes.
 * - `{a,b}` brace alternatives (nesting supported).
 *
 * Keeping these semantics identical matters: the analyser and the generated
 * GitLab rules must select exactly the same jobs for the same change set.
 */

const cache = new Map<string, RegExp[]>();

/** Expand `{a,b}` alternatives (nested) into plain patterns. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const prefix = pattern.slice(0, start);
        const suffix = pattern.slice(i + 1);
        const body = pattern.slice(start + 1, i);
        const alternatives = splitTopLevel(body);
        return alternatives.flatMap((alt) => expandBraces(prefix + alt + suffix));
      }
    }
  }
  return [pattern];
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? '';
    if (ch === '\\') {
      current += ch + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** Convert one brace-free fnmatch pattern into an anchored RegExp. */
export function fnmatchToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';
    const atSegmentStart = i === 0 || pattern[i - 1] === '/';
    if (ch === '*' && pattern[i + 1] === '*' && atSegmentStart && pattern[i + 2] === '/') {
      // `**/` : zero or more directories
      re += '(?:[^/]+/)*';
      i += 3;
      continue;
    }
    if (ch === '*') {
      // collapse runs of `*` (a `**` not followed by `/` behaves like `*`)
      while (pattern[i + 1] === '*') i++;
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        re += '\\[';
        i++;
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      cls = cls.replace(/\\/g, '\\\\');
      re += `(?!/)[${cls}]`;
      i = close + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      re += escapeRegex(pattern[i + 1] ?? '');
      i += 2;
      continue;
    }
    re += escapeRegex(ch);
    i++;
  }
  return new RegExp(`^${re}$`);
}

function compile(pattern: string): RegExp[] {
  let compiled = cache.get(pattern);
  if (!compiled) {
    compiled = expandBraces(pattern).map(fnmatchToRegExp);
    cache.set(pattern, compiled);
  }
  return compiled;
}

/** True when `path` (repo-relative, forward slashes, no leading `./`) matches `pattern`. */
export function matchGlob(pattern: string, path: string): boolean {
  return compile(pattern).some((re) => re.test(path));
}

export function matchAny(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((p) => matchGlob(p, path));
}

/**
 * Patterns that look recursive but are not under fnmatch semantics
 * (`dir/**` without a trailing `/*`) are a classic GitLab foot-gun.
 */
export function lintPattern(pattern: string): string | undefined {
  if (pattern.startsWith('/') || pattern.startsWith('./')) {
    return `pattern "${pattern}" must be repo-relative without a leading "/" or "./"`;
  }
  if (/\*\*(?!\/)/.test(pattern)) {
    return `pattern "${pattern}" uses "**" not followed by "/"; under GitLab fnmatch semantics this matches a single path segment. Use "…/**/*".`;
  }
  return undefined;
}
