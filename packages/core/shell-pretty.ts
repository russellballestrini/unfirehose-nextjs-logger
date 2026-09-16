// A bash one-liner laid out as a script a person can read.
//
// A harness writes `cd x && make test 2>&1 | tail -3; echo done` on one
// line because the tool takes one string. Reading forty of those in a
// feed is the thing nobody does. This splits a command at its top-level
// control operators — `;` `&&` `||` `|` `&` — one statement per line,
// continuation operators leading the next line the way a shell script
// is written by hand, and indents the bodies of if/for/while/case. It
// touches nothing inside quotes, `$( )`, `( )`, `{ }`, backticks or a
// heredoc body, so a command it reformats still means the same thing.
// Pure, idempotent (pretty(pretty(x)) === pretty(x)) and fail-open: an
// unbalanced quote leaves the text as it came.

const OPENERS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/** Words that close a body and are written at the parent indent. */
const BODY_CLOSE = new Set(['fi', 'done', 'esac']);

interface Piece { text: string; joiner: '' | ';' | '&&' | '||' | '|' | '&' | '|&' }

/**
 * Split at top-level operators. Returns null when the text is not safely
 * tokenizable (an unterminated quote or heredoc) so the caller can leave it.
 */
function splitTopLevel(src: string): Piece[] | null {
  const pieces: Piece[] = [];
  let buf = '';
  let i = 0;
  const depth: string[] = [];
  let heredoc: { tag: string; stripTabs: boolean } | null = null;
  let pendingHeredoc: { tag: string; stripTabs: boolean } | null = null;

  const push = (joiner: Piece['joiner']) => {
    pieces.push({ text: buf, joiner });
    buf = '';
  };

  while (i < src.length) {
    const c = src[i];

    // Inside a heredoc body: copy whole lines until the terminator line.
    if (heredoc) {
      const nl = src.indexOf('\n', i);
      const line = nl === -1 ? src.slice(i) : src.slice(i, nl);
      const probe = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      buf += nl === -1 ? line : line + '\n';
      i = nl === -1 ? src.length : nl + 1;
      if (probe === heredoc.tag) heredoc = null;
      continue;
    }

    // Quotes: copy verbatim to the matching close.
    if (c === "'" ) {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      buf += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { closed = true; break; }
        j++;
      }
      if (!closed) return null;
      buf += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end === -1) return null;
      buf += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '\\') {
      buf += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    // A comment runs to end of line and is never split.
    if (c === '#' && (i === 0 || /[\s;|&(]/.test(src[i - 1]))) {
      const nl = src.indexOf('\n', i);
      buf += nl === -1 ? src.slice(i) : src.slice(i, nl);
      i = nl === -1 ? src.length : nl;
      continue;
    }

    // Heredoc operator: remember the tag, the body starts after this line.
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (src[j] === '-') { stripTabs = true; j++; }
      while (src[j] === ' ') j++;
      let tag = '';
      if (src[j] === "'" || src[j] === '"') {
        const q = src[j];
        const end = src.indexOf(q, j + 1);
        if (end === -1) return null;
        tag = src.slice(j + 1, end);
        j = end + 1;
      } else {
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) tag += src[j++];
      }
      if (!tag) { buf += src.slice(i, j); i = j; continue; }
      pendingHeredoc = { tag, stripTabs };
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // Nesting: nothing inside is a top-level operator.
    if (c === '$' && src[i + 1] === '(') { depth.push(')'); buf += '$('; i += 2; continue; }
    if (c === '$' && src[i + 1] === '{') { depth.push('}'); buf += '${'; i += 2; continue; }
    if (OPENERS[c] && (c !== '{' || depth.length > 0 || /(^|\s)$/.test(buf))) {
      depth.push(OPENERS[c]);
      buf += c;
      i++;
      continue;
    }
    if (depth.length && c === depth[depth.length - 1]) {
      depth.pop();
      buf += c;
      i++;
      continue;
    }

    if (c === '\n') {
      if (pendingHeredoc) {
        // The body belongs to the command that opened it: same piece.
        heredoc = pendingHeredoc;
        pendingHeredoc = null;
        buf += c;
        i++;
        continue;
      }
      if (depth.length) { buf += c; i++; continue; }
      push('');
      i++;
      continue;
    }

    if (depth.length) { buf += c; i++; continue; }

    // Top-level operators.
    if (c === '&' && src[i + 1] === '&') { push('&&'); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { push('||'); i += 2; continue; }
    if (c === '|' && src[i + 1] === '&') { push('|&'); i += 2; continue; }
    if (c === '|') { push('|'); i++; continue; }
    if (c === ';' && src[i + 1] === ';') { buf += ';;'; push(';'); i += 2; continue; }   // case arm end
    if (c === ';') { push(';'); i++; continue; }
    if (c === '&' && !/[<>]$/.test(buf)) { push('&'); i++; continue; }         // background, not `2>&1`

    buf += c;
    i++;
  }
  if (heredoc || depth.length) return null;
  pieces.push({ text: buf, joiner: '' });
  return pieces;
}

function firstWord(s: string): string {
  return (s.trim().match(/^[^\s]+/) || [''])[0];
}

/**
 * Lay a shell command out one statement per line.
 *
 * A one-liner with nothing to split comes back unchanged. Already
 * multi-line text keeps its lines and only gains splits inside them.
 */
export function prettifyShell(command: string): string {
  if (typeof command !== 'string') return '';
  const src = command.replace(/\r\n/g, '\n');
  if (!src.trim()) return command;
  const pieces = splitTopLevel(src);
  if (!pieces) return command;

  const out: string[] = [];
  let indent = 0;
  let prevJoiner: Piece['joiner'] = '';

  const emit = (text: string, joiner: Piece['joiner']) => {
    const pad = '  '.repeat(indent);
    if (joiner === '&&' || joiner === '||' || joiner === '|' || joiner === '|&') {
      // The operator leads the continuation line, one level in.
      out.push(`${pad}  ${joiner} ${text}`);
    } else {
      out.push(pad + text);
    }
  };

  for (const piece of pieces) {
    let text = piece.text.trim();
    if (!text) { if (piece.joiner) prevJoiner = piece.joiner; continue; }
    let word = firstWord(text);

    // `if …; then cmd` / `for …; do cmd`: the keyword stays on the
    // statement line, the command after it starts the indented body.
    if ((word === 'then' || word === 'do') && out.length && prevJoiner === ';') {
      out[out.length - 1] += `; ${word}`;
      indent += 1;
      text = text.slice(word.length).trim();
      if (!text) { prevJoiner = piece.joiner; continue; }
      word = firstWord(text);
    } else if (word === 'else' || word === 'elif') {
      indent = Math.max(0, indent - 1);
      if (word === 'else') {
        emit('else', '');
        indent += 1;
        text = text.slice(4).trim();
        if (!text) { prevJoiner = piece.joiner; continue; }
        word = firstWord(text);
      }
    } else if (BODY_CLOSE.has(word)) {
      indent = Math.max(0, indent - 1);
    }

    // `case x in a) …;;`: the arms start on their own lines under `in`.
    if (word === 'case') {
      const m = text.match(/^(case\s+\S+\s+in)\s+(\S[\s\S]*)$/);
      if (m) {
        emit(m[1], prevJoiner);
        indent += 1;
        emit(m[2], '');
        prevJoiner = piece.joiner === '&' ? '' : piece.joiner;
        continue;
      }
    }

    emit(text, prevJoiner);
    if (piece.joiner === '&') out[out.length - 1] += ' &';

    const lastWord = (text.match(/[^\s]+$/) || [''])[0];
    if (word === 'elif') {
      // `elif …; then` opens its body through the `then` merge above.
    } else if (word === 'case' || lastWord === 'then' || lastWord === 'do'
               || word === 'then' || word === 'do') {
      indent += 1;
    } else if (word === 'else' && lastWord !== 'fi') {
      indent += 1;
    }
    prevJoiner = piece.joiner === '&' ? '' : piece.joiner;
  }
  return out.join('\n');
}

/** True when prettifying would change the layout — what a toggle badge wants. */
export function shellHasStructure(command: string): boolean {
  return prettifyShell(command) !== command;
}
