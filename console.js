/* Career console — a SQL REPL over the CV that is already on this page.
 *
 * THE DOM IS THE SOURCE OF TRUTH. Tables are built by reading data-* attributes
 * off the CV markup, so the queryable data and the printed CV can never drift
 * apart. The contract, and the only coupling between this file and index.html:
 *
 *   roles      .board li          data-title data-company data-start data-end
 *                                 data-current data-note
 *   projects   .build             data-name data-lang data-stars data-url data-blurb
 *   skills     .rack li           data-name data-category
 *   education  .credits > div     data-qualification data-institution data-start data-end
 *   contact    .elsewhere a       data-channel data-handle  (+ href)
 *
 * Edit the markup and the tables follow. Rename an attribute and you must
 * update the readers below.
 */
(function () {
  'use strict';

  var KEYWORDS = ['SELECT','FROM','WHERE','ORDER','BY','ASC','DESC','LIMIT','AND','OR','LIKE','IN','NOT','EXPLAIN','COUNT'];

  /* ── tables, read out of the page ─────────────────────────────── */

  function buildTables() {
    var t = {};

    t.roles = [].map.call(document.querySelectorAll('.board li'), function (li) {
      return {
        title: li.dataset.title,
        company: li.dataset.company,
        start: li.dataset.start,
        end: li.dataset.end || null,
        current: li.dataset.current === 'true',
        note: li.dataset.note || null
      };
    });

    t.projects = [].map.call(document.querySelectorAll('.build'), function (el) {
      return {
        name: el.dataset.name,
        lang: el.dataset.lang,
        stars: Number(el.dataset.stars || 0),
        url: el.dataset.url,
        blurb: el.dataset.blurb
      };
    });

    t.skills = [].map.call(document.querySelectorAll('.rack li'), function (el) {
      return { name: el.dataset.name, category: el.dataset.category };
    });

    t.education = [].map.call(document.querySelectorAll('.credits > div'), function (el) {
      return {
        qualification: el.dataset.qualification,
        institution: el.dataset.institution,
        start: el.dataset.start || null,
        end: el.dataset.end
      };
    });

    t.contact = [].map.call(document.querySelectorAll('.elsewhere a'), function (a) {
      return { channel: a.dataset.channel, handle: a.dataset.handle, url: a.getAttribute('href') };
    });

    // one synthetic row, so `SELECT * FROM career` says something
    var years = new Date().getFullYear() - 2011;
    t.career = [{
      name: 'Valerian Pereira',
      role: 'Head of Data Platform',
      company: 'BookMyShow',
      city: 'Mumbai',
      years_shipping: years,
      open_source: t.projects.length + ' projects'
    }];

    return t;
  }

  /* ── errors ───────────────────────────────────────────────────── */

  function SqlError(msg, pos, hint) {
    this.msg = msg; this.pos = pos == null ? -1 : pos; this.hint = hint || null;
  }

  /* ── tokenizer ────────────────────────────────────────────────── */

  function tokenize(src) {
    var out = [], i = 0;
    while (i < src.length) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === ';') { i++; continue; }
      var start = i;
      if (c === "'") {
        i++;
        var s = '';
        while (i < src.length && src[i] !== "'") { s += src[i++]; }
        if (i >= src.length) throw new SqlError('unterminated quoted string', start);
        i++;
        out.push({ t: 'str', v: s, pos: start });
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < src.length && /[0-9.]/.test(src[i])) i++;
        out.push({ t: 'num', v: Number(src.slice(start, i)), pos: start });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
        var w = src.slice(start, i);
        var up = w.toUpperCase();
        out.push({ t: KEYWORDS.indexOf(up) > -1 ? 'kw' : 'ident', v: KEYWORDS.indexOf(up) > -1 ? up : w, pos: start });
        continue;
      }
      var two = src.slice(i, i + 2);
      if (two === '!=' || two === '<>' || two === '<=' || two === '>=') {
        i += 2; out.push({ t: 'op', v: two === '<>' ? '!=' : two, pos: start }); continue;
      }
      if ('=<>'.indexOf(c) > -1) { i++; out.push({ t: 'op', v: c, pos: start }); continue; }
      if ('*,()'.indexOf(c) > -1) { i++; out.push({ t: 'punc', v: c, pos: start }); continue; }
      throw new SqlError('syntax error at or near "' + c + '"', start);
    }
    return out;
  }

  /* ── parser: SELECT cols FROM t [WHERE ..] [ORDER BY ..] [LIMIT n] ── */

  function parse(toks) {
    var i = 0;
    function peek() { return toks[i]; }
    function at(t, v) { var k = toks[i]; return k && k.t === t && (v == null || k.v === v); }
    function eat(t, v, what) {
      if (!at(t, v)) {
        var k = toks[i];
        throw new SqlError('syntax error at or near "' + (k ? k.v : 'end of input') + '"',
          k ? k.pos : (toks.length ? toks[toks.length - 1].pos : 0),
          what ? 'Expected ' + what + '.' : null);
      }
      return toks[i++];
    }

    var q = { explain: false, count: false, cols: null, table: null, where: [], order: null, limit: null };

    if (at('kw', 'EXPLAIN')) { i++; q.explain = true; }
    eat('kw', 'SELECT', 'SELECT');

    if (at('kw', 'COUNT')) {
      i++; eat('punc', '(', '('); eat('punc', '*', '*'); eat('punc', ')', ')');
      q.count = true; q.cols = ['count'];
    } else if (at('punc', '*')) {
      i++; q.cols = '*';
    } else {
      q.cols = [];
      do {
        q.cols.push(eat('ident', null, 'a column name').v);
      } while (at('punc', ',') && ++i);
    }

    eat('kw', 'FROM', 'FROM');
    q.table = eat('ident', null, 'a table name');

    if (at('kw', 'WHERE')) {
      i++;
      var lastJoin = null;
      do {
        var join = q.where.length ? lastJoin : null;
        var col = eat('ident', null, 'a column name');
        var cond = { col: col.v, pos: col.pos, join: join };
        if (at('op')) {
          cond.op = toks[i++].v;
          cond.val = literal();
        } else if (at('kw', 'LIKE')) {
          i++; cond.op = 'LIKE'; cond.val = literal();
        } else if (at('kw', 'IN')) {
          i++; eat('punc', '(', '(');
          cond.op = 'IN'; cond.val = [];
          do { cond.val.push(literal()); } while (at('punc', ',') && ++i);
          eat('punc', ')', ')');
        } else {
          cond.op = 'TRUTHY';
        }
        q.where.push(cond);
        lastJoin = null;
        if (at('kw', 'AND') || at('kw', 'OR')) { lastJoin = toks[i].v; i++; } else break;
      } while (true);
    }

    function literal() {
      if (at('str') || at('num')) return toks[i++].v;
      if (at('ident')) return toks[i++].v;      // bare word, treat as string
      var k = peek();
      throw new SqlError('syntax error at or near "' + (k ? k.v : 'end of input') + '"',
        k ? k.pos : 0, 'Expected a value.');
    }

    if (at('kw', 'ORDER')) {
      i++; eat('kw', 'BY', 'BY');
      var oc = eat('ident', null, 'a column name');
      var dir = 'ASC';
      if (at('kw', 'ASC') || at('kw', 'DESC')) dir = toks[i++].v;
      q.order = { col: oc.v, pos: oc.pos, dir: dir };
    }

    if (at('kw', 'LIMIT')) { i++; q.limit = eat('num', null, 'a number').v; }

    if (i < toks.length) {
      throw new SqlError('syntax error at or near "' + toks[i].v + '"', toks[i].pos);
    }
    return q;
  }

  /* ── evaluator ────────────────────────────────────────────────── */

  function like(val, pat) {
    var rx = '^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*').replace(/_/g, '.') + '$';
    return new RegExp(rx, 'i').test(String(val));
  }

  function compare(a, op, b) {
    if (op === 'LIKE') return like(a, b);
    if (op === 'IN') return b.some(function (x) { return String(a).toLowerCase() === String(x).toLowerCase(); });
    if (op === 'TRUTHY') return !!a && a !== 'false';
    if (typeof a === 'number' || typeof b === 'number') { a = Number(a); b = Number(b); }
    else { a = String(a).toLowerCase(); b = String(b).toLowerCase(); }
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
    return false;
  }

  function run(q, tables) {
    var rows = tables[q.table.v];
    if (!rows) {
      throw new SqlError('relation "' + q.table.v + '" does not exist', q.table.pos,
        'Try \\dt to list tables.');
    }
    var colsAvailable = Object.keys(rows[0] || {});

    function checkCol(name, pos) {
      if (colsAvailable.indexOf(name) === -1) {
        throw new SqlError('column "' + name + '" does not exist', pos,
          'Columns: ' + colsAvailable.join(', ') + '.');
      }
    }

    q.where.forEach(function (c) { checkCol(c.col, c.pos); });
    if (q.order) checkCol(q.order.col, q.order.pos);
    if (q.cols !== '*' && !q.count) {
      q.cols.forEach(function (c) { checkCol(c, q.table.pos); });
    }

    var out = rows.filter(function (r) {
      if (!q.where.length) return true;
      var acc = compare(r[q.where[0].col], q.where[0].op, q.where[0].val);
      for (var j = 1; j < q.where.length; j++) {
        var c = q.where[j], v = compare(r[c.col], c.op, c.val);
        acc = c.join === 'OR' ? (acc || v) : (acc && v);
      }
      return acc;
    });

    if (q.order) {
      var oc = q.order.col, sign = q.order.dir === 'DESC' ? -1 : 1;
      out = out.slice().sort(function (x, y) {
        var a = x[oc], b = y[oc];
        if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
        return String(a).localeCompare(String(b)) * sign;
      });
    }

    if (q.limit != null) out = out.slice(0, q.limit);
    if (q.count) return { cols: ['count'], rows: [{ count: out.length }] };

    var cols = q.cols === '*' ? colsAvailable : q.cols;
    return {
      cols: cols,
      rows: out.map(function (r) {
        var o = {}; cols.forEach(function (c) { o[c] = r[c]; }); return o;
      })
    };
  }

  /* ── psql-shaped rendering ────────────────────────────────────── */

  function cell(v) {
    if (v === null || v === undefined || v === '') return '';
    return String(v);
  }

  function renderTable(res) {
    var w = res.cols.map(function (c) {
      return Math.max(c.length, Math.max.apply(null, [0].concat(res.rows.map(function (r) { return cell(r[c]).length; }))));
    });
    var pad = function (s, n) { return s + Array(n - s.length + 1).join(' '); };
    var lines = [];
    lines.push(' ' + res.cols.map(function (c, i) { return pad(c, w[i]); }).join(' | '));
    lines.push(w.map(function (n) { return Array(n + 3).join('-'); }).join('+'));
    res.rows.forEach(function (r) {
      lines.push(' ' + res.cols.map(function (c, i) { return pad(cell(r[c]), w[i]); }).join(' | '));
    });
    if (!res.rows.length) lines.push('(0 rows)');
    else lines.push('(' + res.rows.length + ' row' + (res.rows.length === 1 ? '' : 's') + ')');
    return lines.join('\n');
  }

  function renderError(e, src) {
    var out = 'ERROR:  ' + e.msg;
    if (e.pos > -1 && src) {
      out += '\nLINE 1: ' + src + '\n' + Array(9 + e.pos).join(' ') + '^';
    }
    if (e.hint) out += '\nHINT:  ' + e.hint;
    return out;
  }

  function explainPlan(q, tables) {
    var rows = tables[q.table.v] || [];
    var lines = [];
    lines.push((q.order ? 'Sort' : 'Seq Scan') + ' on ' + q.table.v +
      '  (cost=0.00..0.01 rows=' + rows.length + ' width=' + (Object.keys(rows[0] || {}).length * 8) + ')');
    if (q.order) lines.push('  Sort Key: ' + q.order.col + (q.order.dir === 'DESC' ? ' DESC' : ''));
    if (q.where.length) lines.push('  Filter: (' + q.where.map(function (c) {
      return c.op === 'TRUTHY' ? c.col : c.col + ' ' + c.op.toLowerCase() + ' ' + JSON.stringify(c.val);
    }).join(' and ') + ')');
    if (!q.where.length) lines.push('  Filter: (chai = true)');
    lines.push('  Planning Time: 0.042 ms');
    lines.push('  Execution Time: 15 years');
    return lines.join('\n');
  }

  /* ── the one public entry point the REPL and the self-test share ── */

  function execute(src, tables) {
    var trimmed = src.trim().replace(/;+$/, '');
    var q = parse(tokenize(trimmed));
    if (q.explain) return { text: explainPlan(q, tables) };
    var res = run(q, tables);
    return { text: renderTable(res), res: res };
  }

  /* ── meta commands ────────────────────────────────────────────── */

  var HELP = [
    'This is a résumé you can query. It speaks a useful subset of SQL.',
    '',
    '  \\dt            list tables',
    '  \\d <table>     describe a table',
    '  \\resume        read it as an ordinary CV instead',
    '  \\?             this help',
    '',
    '  SELECT <cols|*> FROM <table>',
    '    [WHERE <col> = | != | < | > | LIKE | IN (..) <value>]',
    '    [ORDER BY <col> [DESC]] [LIMIT <n>]',
    '  SELECT COUNT(*) FROM <table>',
    '  EXPLAIN <query>',
    '',
    'Try:  SELECT title, company FROM roles WHERE current;'
  ].join('\n');

  function meta(cmd, tables, api) {
    var parts = cmd.trim().split(/\s+/);
    var c = parts[0];
    if (c === '\\?' || c === '\\h' || c === 'help') return HELP;
    if (c === '\\dt') {
      var names = Object.keys(tables);
      return renderTable({
        cols: ['schema', 'name', 'type', 'rows'],
        rows: names.map(function (n) {
          return { schema: 'public', name: n, type: 'table', rows: tables[n].length };
        })
      });
    }
    if (c === '\\d') {
      var t = parts[1];
      if (!t) return 'HINT:  \\d <table>. Try \\dt for the list.';
      if (!tables[t]) return renderError(new SqlError('relation "' + t + '" does not exist', -1, 'Try \\dt to list tables.'), null);
      var sample = tables[t][0] || {};
      return 'Table "public.' + t + '"\n' + renderTable({
        cols: ['column', 'type'],
        rows: Object.keys(sample).map(function (k) {
          var v = sample[k];
          return { column: k, type: typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : 'text' };
        })
      }).replace(/\n\(\d+ rows?\)$/, '');
    }
    if (c === '\\resume' || c === '\\q') { api.toCv(); return 'Switching to the printed CV…'; }
    return null;
  }

  /* ── REPL ─────────────────────────────────────────────────────── */

  function boot() {
    var shell = document.getElementById('console');
    if (!shell) return;

    var out = shell.querySelector('.cn-out'),
        input = shell.querySelector('.cn-input'),
        chips = shell.querySelectorAll('.cn-chip'),
        tables = buildTables(),
        history = [], hi = -1;

    var api = {
      toCv: function () { setMode('cv'); },
      toConsole: function () { setMode('console'); }
    };

    function write(cls, text) {
      var el = document.createElement('pre');
      el.className = cls;
      el.textContent = text;
      out.appendChild(el);
      out.scrollTop = out.scrollHeight;
      return el;
    }

    function submit(src) {
      if (!src.trim()) return;
      history.push(src); hi = history.length;
      write('cn-echo', 'career=# ' + src);
      var m = null;
      try {
        if (src.trim()[0] === '\\' || src.trim().toLowerCase() === 'help') {
          m = meta(src, tables, api);
          write('cn-res', m == null ? renderError(new SqlError('unrecognised command "' + src.trim() + '"', -1, 'Try \\? for help.'), null) : m);
        } else {
          write('cn-res', execute(src, tables).text);
        }
      } catch (e) {
        if (e instanceof SqlError) write('cn-err', renderError(e, src.trim().replace(/;+$/, '')));
        else write('cn-err', 'ERROR:  ' + (e && e.message ? e.message : 'unknown error'));
      }
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { submit(input.value); input.value = ''; }
      else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = history[hi]; } e.preventDefault(); }
      else if (e.key === 'ArrowDown') { if (hi < history.length - 1) { hi++; input.value = history[hi]; } else { hi = history.length; input.value = ''; } e.preventDefault(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        var words = input.value.split(/\s+/), last = words[words.length - 1].toLowerCase();
        if (!last) return;
        var pool = Object.keys(tables);
        Object.keys(tables).forEach(function (t) { pool = pool.concat(Object.keys(tables[t][0] || {})); });
        var hit = pool.filter(function (w) { return w.toLowerCase().indexOf(last) === 0; });
        if (hit.length === 1) { words[words.length - 1] = hit[0]; input.value = words.join(' '); }
        else if (hit.length > 1) write('cn-res', hit.join('   '));
      }
    });

    [].forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        var q = chip.dataset.q;
        input.value = q;
        submit(q);
        input.value = '';
        chip.classList.add('done');
        input.focus();
      });
    });

    shell.addEventListener('click', function (e) {
      if (e.target.closest('.cn-chip') || window.getSelection().toString()) return;
      input.focus();
    });

    // greeting
    write('cn-note', 'psql (valerian ' + new Date().getFullYear() + '.1) — type \\? for help');
    write('cn-note', 'A résumé you can query. Tap a query below, or write your own.');

    var shared = new URLSearchParams(location.search).get('q');
    if (shared) submit(shared);

    window.__selftest = function () { return selftest(tables); };
  }

  /* ── mode switching ───────────────────────────────────────────── */

  function setMode(mode) {
    document.documentElement.dataset.mode = mode;
    try { localStorage.setItem('vp-mode', mode); } catch (e) {}
    var btn = document.getElementById('mode-toggle');
    if (btn) btn.textContent = mode === 'cv' ? 'Open console' : 'View as CV';
    if (mode === 'console') {
      var i = document.querySelector('.cn-input');
      if (i) i.focus();
    }
    window.scrollTo(0, 0);
  }

  /* ── self-check: the smallest thing that fails if the engine breaks ── */

  function selftest(tables) {
    tables = tables || buildTables();
    var fails = [];
    function ok(label, cond) { if (!cond) fails.push(label); }
    function q(sql) { return execute(sql, tables).res; }

    ok('roles table populated', tables.roles.length === 7);
    ok('one current role', q('SELECT title FROM roles WHERE current').rows.length === 1);
    ok('current role is data platform', /Head of Data Platform/.test(q('SELECT title FROM roles WHERE current').rows[0].title));
    ok('order+limit picks top project', q('SELECT name, stars FROM projects ORDER BY stars DESC LIMIT 1').rows[0].name === 'backup-action');
    ok('count(*) counts', q('SELECT COUNT(*) FROM projects').rows[0].count === tables.projects.length);
    ok('where = filters', q("SELECT name FROM skills WHERE category = 'data'").rows.length > 0);
    ok('LIKE filters', q("SELECT title FROM roles WHERE title LIKE '%Manager%'").rows.length === 4);
    ok('projection limits columns', Object.keys(q('SELECT name FROM projects').rows[0]).length === 1);

    var threw = null;
    try { execute('SELECT * FROM jobs', tables); } catch (e) { threw = e; }
    ok('unknown table errors', threw && /does not exist/.test(threw.msg));
    threw = null;
    try { execute('SELECT nope FROM roles', tables); } catch (e) { threw = e; }
    ok('unknown column errors', threw && /column "nope"/.test(threw.msg));
    threw = null;
    try { execute('SELECT FROM', tables); } catch (e) { threw = e; }
    ok('garbage errors cleanly', threw && /syntax error/.test(threw.msg));

    if (fails.length) { console.error('selftest FAILED:', fails); return { pass: false, fails: fails }; }
    console.log('selftest passed');
    return { pass: true, fails: [] };
  }

  /* ── init ─────────────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', function () {
    document.documentElement.classList.add('has-console');
    var saved;
    try { saved = localStorage.getItem('vp-mode'); } catch (e) {}
    setMode(saved === 'cv' ? 'cv' : 'console');
    var btn = document.getElementById('mode-toggle');
    if (btn) btn.addEventListener('click', function () {
      setMode(document.documentElement.dataset.mode === 'cv' ? 'console' : 'cv');
    });
    boot();
  });
})();
