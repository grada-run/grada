// Shared HCL block-manipulation toolkit for CLI commands that patch
// generated Terraform files (container env injection, worker lifecycle,
// snapshot pins, CloudFront domain wiring).
//
// All helpers are pure string functions. Every scanner is aware of
// double-quoted string literals (with backslash escapes) and `#` / `//`
// line comments plus `/* */` block comments, so brackets and identifiers
// inside them never disturb matching. Returned bounds are indices into the
// string that was passed in; `null` means "not found" and callers must
// leave the content unchanged.
const OPEN_TO_CLOSE = { '{': '}', '[': ']', '(': ')' };

function isIdentChar(ch) {
    return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

// Advances `index` past whitespace and comments. Returns the first index
// at or after `index` holding meaningful content.
function skipTrivia(content, index) {
    let i = index;
    for (;;) {
        while (i < content.length && /\s/.test(content[i])) i++;
        if (content.startsWith('//', i) || content[i] === '#') {
            const end = content.indexOf('\n', i);
            i = end === -1 ? content.length : end + 1;
            continue;
        }
        if (content.startsWith('/*', i)) {
            const end = content.indexOf('*/', i + 2);
            i = end === -1 ? content.length : end + 2;
            continue;
        }
        return i;
    }
}

// Skips one double-quoted string literal starting at the opening quote.
// Returns the index just past the closing quote (or content.length when
// unterminated).
function skipString(content, index) {
    let i = index + 1;
    while (i < content.length) {
        if (content[i] === '\\') {
            i += 2;
            continue;
        }
        if (content[i] === '"') return i + 1;
        i++;
    }
    return i;
}

// Finds the balanced close for the bracket at `openIdx`. Returns
// `{ openIdx, closeIdx }` or null when the opener is missing or the
// bracket is unterminated.
function scanBalanced(content, openIdx, openCh) {
    const text = String(content ?? '');
    if (text[openIdx] !== openCh) return null;
    const closeCh = OPEN_TO_CLOSE[openCh];
    let depth = 0;
    let i = openIdx;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (ch === openCh) {
            depth++;
        } else if (ch === closeCh) {
            depth--;
            if (depth === 0) return { openIdx, closeIdx: i };
        }
        i++;
    }
    return null;
}

function escapeRegExp(raw) {
    return String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locates `resource "<type>" "<name>" { ... }`. Returns
// `{ headerIdx, openIdx, closeIdx }` or null when the resource or its
// braces cannot be found.
export function findResourceBlock(content, resourceType, resourceName) {
    const text = String(content ?? '');
    const pattern = new RegExp(
        `resource\\s+"${escapeRegExp(resourceType)}"\\s+"${escapeRegExp(resourceName)}"`
    );
    const match = pattern.exec(text);
    if (!match) return null;
    const headerIdx = match.index;
    const openIdx = text.indexOf('{', headerIdx + match[0].length);
    if (openIdx === -1) return null;
    const bounds = scanBalanced(text, openIdx, '{');
    if (!bounds) return null;
    return { headerIdx, openIdx, closeIdx: bounds.closeIdx };
}

// Removes the `resource "type" "name" { ... }` block plus comment lines
// directly attached above it (walking up over blanks, stopping at the
// first line of code). Returns the content unchanged when absent. Callers
// should normalize blank lines afterwards.
export function removeResourceBlock(content, resourceType, resourceName) {
    const text = String(content ?? '');
    const found = findResourceBlock(text, resourceType, resourceName);
    if (!found) return text;
    const lines = text.slice(0, found.headerIdx).split('\n');
    let firstKept = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.trim() === '' || /^\s*#/.test(line)) {
            firstKept = i;
            continue;
        }
        break;
    }
    const start = firstKept === 0 ? 0 : lines.slice(0, firstKept).join('\n').length + 1;
    return text.slice(0, start) + text.slice(found.closeIdx + 1);
}

// Locates a nested `blockName { ... }` (with optional quoted labels)
// at the top level of a block slice. Returns
// `{ startIdx, openIdx, closeIdx }` (startIdx is the keyword) or null.
export function findNestedBlock(blockContent, blockName) {
    const text = String(blockContent ?? '');
    const name = String(blockName ?? '');
    if (!name) return null;
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}') {
            depth = Math.max(0, depth - 1);
            i++;
            continue;
        }
        if (depth === 1 && /[A-Za-z_]/.test(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            let end = i + 1;
            while (end < text.length && isIdentChar(text[end])) end++;
            if (text.slice(i, end) === name) {
                let j = skipTrivia(text, end);
                // Skip optional quoted labels (`block "label" {`).
                while (text[j] === '"') j = skipTrivia(text, skipString(text, j));
                if (text[j] === '{') {
                    const bounds = scanBalanced(text, j, '{');
                    if (!bounds) return null;
                    return { startIdx: i, openIdx: bounds.openIdx, closeIdx: bounds.closeIdx };
                }
            }
            i = end;
            continue;
        }
        i++;
    }
    return null;
}

// Splices `replacement` over `bounds` (`{ startIdx, openIdx, closeIdx }`
// from the finders above; startIdx falls back to openIdx).
export function replaceBlock(content, bounds, replacement) {
    const text = String(content ?? '');
    if (!bounds || typeof bounds.closeIdx !== 'number') return text;
    const start = typeof bounds.startIdx === 'number' ? bounds.startIdx : bounds.openIdx;
    if (typeof start !== 'number') return text;
    return text.slice(0, start) + String(replacement ?? '') + text.slice(bounds.closeIdx + 1);
}

// Finds a top-level `key = <value>` attribute inside a block slice.
// Returns `{ lineStart, keyStart, valueStart, valueEnd }` (valueEnd is
// exclusive, before the trailing newline or closing brace) or null.
function findAttributeBounds(blockContent, key) {
    const text = String(blockContent ?? '');
    const name = String(key ?? '');
    if (!name) return null;
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth = Math.max(0, depth - 1);
            i++;
            continue;
        }
        if (depth === 1 && /[A-Za-z_]/.test(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            let end = i + 1;
            while (end < text.length && isIdentChar(text[end])) end++;
            if (text.slice(i, end) === name) {
                const after = skipTrivia(text, end);
                if (text[after] === '=') {
                    const valueStart = skipTrivia(text, after + 1);
                    const valueEnd = scanAttributeValueEnd(text, valueStart);
                    if (valueEnd === null) return null;
                    const lineStart = text.lastIndexOf('\n', i) + 1;
                    return { lineStart, keyStart: i, valueStart, valueEnd };
                }
            }
            i = end;
            continue;
        }
        i++;
    }
    return null;
}

// Finds the end of an attribute value: the newline (or closing brace)
// reached while no brackets are open. Values may span lines.
function scanAttributeValueEnd(text, valueStart) {
    let depth = 0;
    let i = valueStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            // A `#` comment ends the value only outside brackets; inside
            // (e.g. a heredoc-free list) it is skipped like content.
            if (depth === 0) return i;
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            if (depth === 0) return i;
            depth--;
            i++;
            continue;
        }
        if (ch === '\n' && depth === 0) return i;
        i++;
    }
    return i;
}

// Returns the raw (trimmed) value of a top-level `key = <value>`
// attribute, or null when the attribute is absent.
export function getAttributeValue(blockContent, key) {
    const bounds = findAttributeBounds(blockContent, key);
    if (!bounds) return null;
    return String(blockContent).slice(bounds.valueStart, bounds.valueEnd).trim();
}

// Replaces (or inserts) a top-level `key = <valueExpr>` attribute.
// Insertions reuse the block's existing attribute indent. Returns the
// content unchanged when the value already matches.
export function upsertAttribute(blockContent, key, valueExpr) {
    const text = String(blockContent ?? '');
    const name = String(key ?? '');
    const value = String(valueExpr ?? '');
    const bounds = findAttributeBounds(text, name);
    if (bounds) {
        const current = text.slice(bounds.valueStart, bounds.valueEnd).trim();
        if (current === value.trim()) return text;
        const indent = text.slice(bounds.lineStart, bounds.keyStart);
        return text.slice(0, bounds.lineStart) + `${indent}${name} = ${value}` + text.slice(bounds.valueEnd);
    }
    const closeIdx = text.lastIndexOf('}');
    if (closeIdx === -1) return text;
    const indentMatch = text.match(/^( +)[A-Za-z_][A-Za-z0-9_-]*\s*=/m);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const glue = closeIdx > 0 && text[closeIdx - 1] === '\n' ? '' : '\n';
    return `${text.slice(0, closeIdx)}${glue}${indent}${name} = ${value}\n${text.slice(closeIdx)}`;
}

// Removes a top-level `key = <value>` attribute (including multi-line
// values) along with its line. Returns the content unchanged when absent.
export function removeAttribute(blockContent, key) {
    const text = String(blockContent ?? '');
    const bounds = findAttributeBounds(text, key);
    if (!bounds) return text;
    let end = bounds.valueEnd;
    if (text[end] === '\n') end++;
    return text.slice(0, bounds.lineStart) + text.slice(end);
}

// Locates the first `key = [...]` array assigned in the given content
// (used for `environment = [...]` inside task definitions, where the
// array lives inside nested jsonencode structures rather than at the
// top level of the resource block). Returns `{ openIdx, closeIdx }`
// for the brackets, or null.
export function findArrayBounds(content, key) {
    const text = String(content ?? '');
    const name = String(key ?? '');
    if (!name) return null;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (/[A-Za-z_]/.test(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            let end = i + 1;
            while (end < text.length && isIdentChar(text[end])) end++;
            if (text.slice(i, end) === name) {
                const after = skipTrivia(text, end);
                if (text[after] === '=') {
                    const bracket = skipTrivia(text, after + 1);
                    if (text[bracket] === '[') return scanBalanced(text, bracket, '[');
                    return null;
                }
            }
            i = end;
            continue;
        }
        i++;
    }
    return null;
}

// Locates the first `key = {...}` map assigned in the given content (used
// for `variables = {...}` inside Lambda `environment` blocks, mirroring
// findArrayBounds for ECS `environment = [...]` arrays). Returns
// `{ openIdx, closeIdx }` for the braces, or null.
export function findMapBounds(content, key) {
    const text = String(content ?? '');
    const name = String(key ?? '');
    if (!name) return null;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '#' || text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (/[A-Za-z_]/.test(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            let end = i + 1;
            while (end < text.length && isIdentChar(text[end])) end++;
            if (text.slice(i, end) === name) {
                const after = skipTrivia(text, end);
                if (text[after] === '=') {
                    const brace = skipTrivia(text, after + 1);
                    if (text[brace] === '{') return scanBalanced(text, brace, '{');
                    return null;
                }
            }
            i = end;
            continue;
        }
        i++;
    }
    return null;
}

// Finds the `{ ... }` object enclosing `index` by brace depth.
// Interpolation braces inside quoted values (`${...}`) net to zero, so
// they never disturb the count. Returns null when the index is not
// inside an object.
export function enclosingBraceBounds(text, index) {
    const content = String(text ?? '');
    let openIdx = -1;
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (content[i] === '}') depth++;
        else if (content[i] === '{') {
            if (depth === 0) {
                openIdx = i;
                break;
            }
            depth--;
        }
    }
    if (openIdx === -1) return null;
    const bounds = scanBalanced(content, openIdx, '{');
    if (!bounds) return null;
    return { openIdx: bounds.openIdx, closeIdx: bounds.closeIdx };
}

// Strips indentation from whitespace-only lines (empty expansions like
// `        {{DB_ENV_VARS}}` otherwise leave trailing-space lines that
// `terraform fmt` flags). Lines carrying any other text — including
// heredoc message lines whose trailing space joins wrapped words — are
// left untouched.
export function normalizeBlankLines(content) {
    return String(content ?? '').replace(/^[ \t]+$/gm, '');
}

// Realigns every contiguous run of `KEY = value` lines in a flat HCL map
// block so `terraform fmt` finds nothing to do: keys in a run pad to the
// run's longest key. Blank lines, comments, non-assignment lines, and
// lines whose value opens a nested block (`variables = {`) break runs,
// matching fmt's own grouping. Values must be single-line scalars or
// references (the lambda `variables` use case); multi-line values defeat
// the regex and must not be passed through here.
export function realignAssignmentRuns(text) {
    const lines = String(text ?? '').split('\n');
    const keyOf = (line) => {
        const match = /^(\s*)([A-Za-z0-9_]+)(\s*)=(\s*)(.*)$/.exec(line);
        if (!match) return null;
        if (/^[{[(]/.test(match[5])) return null;
        return { indent: match[1], key: match[2], rest: match[5].replace(/\s+$/, '') };
    };
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (!keyOf(lines[i])) {
            out.push(lines[i]);
            i++;
            continue;
        }
        const run = [];
        while (i < lines.length) {
            const parsed = keyOf(lines[i]);
            if (!parsed) break;
            run.push(parsed);
            i++;
        }
        const width = Math.max(...run.map((entry) => entry.key.length));
        for (const entry of run) {
            out.push(`${entry.indent}${entry.key.padEnd(width)} = ${entry.rest}`);
        }
    }
    return out.join('\n');
}
