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

  /* ── the shell ─────────────────────────────────────────────────── */

  function pad(s, n) { s = String(s); return s + Array(Math.max(0, n - s.length) + 1).join(' '); }
  function dotfill(label, n) {
    var d = n - label.length - 1;
    return label + ' ' + (d > 0 ? Array(d + 1).join('.') : '');
  }

  var ART = [
    '        ▁▁▁▁▁▁▁▁▁▁',
    '       ▕ ██  ██  ▏',
    '       ▕ ██  ██  ▏',
    '       ▕  ▀██▀   ▏',
    '       ▕▁▁▁▁▁▁▁▁▁▏',
    '        ▔▔▔▔▔▔▔▔▔▔'
  ];

  function neofetch(tables) {
    var cur = tables.roles.filter(function (r) { return r.current; })[0] || tables.roles[0];
    var yrs = new Date().getFullYear() - 2011;
    var rows = [
      ['', 'guest@valerianpereira.in'],
      ['', '------------------------'],
      ['host', 'BookMyShow · Mumbai, India'],
      ['os', 'Data Platform ' + yrs + '.0'],
      ['kernel', 'Head of Data Platform'],
      ['uptime', yrs + ' years, still shipping'],
      ['shell', 'zsh · psql'],
      ['packages', tables.projects.length + ' public (46 repos)'],
      ['cpu', 'Databricks · Spark · AWS'],
      ['memory', 'MySQL · Postgres · Mongo · Redis'],
      ['top repo', 'backup-action ★ 54'],
      ['contact', 'valerianpereira25@gmail.com']
    ];
    var out = [], w = 24;
    var n = Math.max(ART.length, rows.length);
    for (var i = 0; i < n; i++) {
      var art = pad(ART[i] || '', w);
      var r = rows[i];
      if (!r) { out.push(art); continue; }
      out.push(art + (r[0] ? pad(r[0], 11) + r[1] : r[1]));
    }
    return out.join('\n');
  }

  var ABOUT = [
    'Valerian Pereira — Head of Data Platform at BookMyShow, in Mumbai.',
    '',
    'Fifteen years building the things other people’s traffic runs on: data',
    'platforms, APIs, and the infrastructure underneath them. Today that means',
    'Databricks and AWS, ingestion and warehousing, and the reporting and',
    'reconciliation systems a ticketing business actually runs on.',
    '',
    'Before that, seven years at BookMyShow working up from writing the platform',
    'to running it, and four at Softaculous building hosting-control-panel software',
    'that shipped to other people’s servers.',
    '',
    'After hours I build small command-line tools — a GitHub Action that backs up',
    'databases, a World Cup tracker for the terminal, a shelf of Alexa skills —',
    'usually because some chore should have automated itself.',
    '',
    'This résumé is also a database. Type `psql` to query it, or `help` to look around.'
  ].join('\n');

  var HELP_SH = [
    'Commands',
    '',
    '  about          who I am, in a paragraph',
    '  work           roles, most recent first',
    '  projects       things I have built in the open',
    '  skills         the stack, by category',
    '  contact        how to reach me',
    '  neofetch       the usual',
    '  snake          take a break',
    '',
    '  psql           open a SQL prompt against my career',
    '  clear          clear the screen',
    '',
    'SQL works from here too — type SELECT … and it just runs.'
  ].join('\n');

  function boot() {
    var shell = document.getElementById('console');
    if (!shell) return;

    var out = shell.querySelector('.cn-out'),
        input = shell.querySelector('.cn-input'),
        ps1 = shell.querySelector('.cn-ps1'),
        chips = shell.querySelectorAll('.cn-chip'),
        tables = buildTables(),
        history = [], hi = -1,
        sqlMode = false,
        game = null,
        reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;

    var ZSH = 'guest@valerianpereira.in ~ %';
    var PSQL = 'career=#';

    var api = { toCv: function () { setMode('cv'); } };

    function setPrompt() { ps1.textContent = sqlMode ? PSQL : ZSH; }

    function write(cls, text) {
      var el = document.createElement('pre');
      el.className = cls;
      el.textContent = text;
      out.appendChild(el);
      out.scrollTop = out.scrollHeight;
      return el;
    }

    /* ── snake ──────────────────────────────────────────────────── */

    var W = 24, H = 13;   // cells; each drawn 2 chars wide so they read square

    function startSnake() {
      if (game) return;
      var body = [[14, 6], [13, 6], [12, 6]], dir = [1, 0], next = [1, 0],
          food = [21, 6], score = 0, dead = false,
          pre = write('cn-game', ''), tick,
          seed = (Date.now() % 2147483646) + 1;

      function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

      function place() {
        do { food = [Math.floor(rnd() * W), Math.floor(rnd() * H)]; }
        while (body.some(function (s) { return s[0] === food[0] && s[1] === food[1]; }));
      }

      function draw() {
        var grid = [], y, x;
        for (y = 0; y < H; y++) { grid.push(new Array(W)); for (x = 0; x < W; x++) grid[y][x] = '  '; }
        grid[food[1]][food[0]] = '◆ ';
        body.forEach(function (s, i) {
          if (s[1] >= 0 && s[1] < H && s[0] >= 0 && s[0] < W) grid[s[1]][s[0]] = i ? '██' : '▓▓';
        });
        var rule = Array(W * 2 + 1).join('─');
        pre.textContent = [
          'snake  ·  arrows or wasd to steer  ·  q to quit' + pad('', 4) + 'score ' + score,
          '┌' + rule + '┐'
        ].concat(grid.map(function (r) { return '│' + r.join('') + '│'; }))
         .concat([
           '└' + rule + '┘',
           dead ? 'game over — score ' + score + '. type snake to play again.' : ''
         ]).join('\n');
        out.scrollTop = out.scrollHeight;
      }

      function step() {
        dir = next;
        var head = [body[0][0] + dir[0], body[0][1] + dir[1]];
        if (head[0] < 0 || head[0] >= W || head[1] < 0 || head[1] >= H ||
            body.some(function (s) { return s[0] === head[0] && s[1] === head[1]; })) {
          dead = true; stop(); draw(); return;
        }
        body.unshift(head);
        if (head[0] === food[0] && head[1] === food[1]) { score += 10; place(); }
        else body.pop();
        draw();
      }

      function key(e) {
        var k = (e.key || '').toLowerCase(), d = null;
        if (k === 'arrowup' || k === 'w') d = [0, -1];
        else if (k === 'arrowdown' || k === 's') d = [0, 1];
        else if (k === 'arrowleft' || k === 'a') d = [-1, 0];
        else if (k === 'arrowright' || k === 'd') d = [1, 0];
        else if (k === 'q' || k === 'escape') { e.preventDefault(); stop(); pre.textContent += '\nquit.'; return; }
        else return;
        e.preventDefault();
        if (d[0] !== -dir[0] || d[1] !== -dir[1]) next = d;
      }

      function stop() {
        clearInterval(tick);
        document.removeEventListener('keydown', key, true);
        game = null;
        input.focus();
      }

      game = { stop: stop };
      document.addEventListener('keydown', key, true);
      place(); draw();
      tick = setInterval(step, 130);
    }

    /* ── command dispatch ───────────────────────────────────────── */

    function table(name, cols, map) {
      return renderTable({ cols: cols, rows: tables[name].map(map) });
    }

    function runShell(src) {
      var cmd = src.trim(), head = cmd.split(/\s+/)[0].toLowerCase();

      if (head === 'about') return ABOUT;
      if (head === 'help' || head === '?') return HELP_SH;
      if (head === 'whoami') return 'valerian — Head of Data Platform at BookMyShow';
      if (head === 'neofetch') return neofetch(tables);
      if (head === 'clear') { out.textContent = ''; return null; }
      if (head === 'snake') { startSnake(); return null; }
      if (head === 'date') return new Date().toString();
      if (head === 'pwd') return '/Users/guest';
      if (head === 'ls') return 'about        contact      projects     skills\ncareer.db    neofetch     work';
      if (head === 'sudo') return 'guest is not in the sudoers file.  This incident has been reported.';
      if (head === 'exit' || head === 'logout') { api.toCv(); return 'Switching to the CV…'; }

      if (head === 'psql' || head === 'sql') {
        sqlMode = true; setPrompt();
        return 'psql (valerian ' + new Date().getFullYear() + '.1)\n' +
               'Type \\? for help, \\q to return to the shell.';
      }

      if (head === 'work' || head === 'roles') {
        return table('roles', ['title', 'company', 'start', 'end'], function (r) {
          return { title: r.title, company: r.company, start: r.start, end: r.end || 'present' };
        });
      }
      if (head === 'projects' || head === 'builds') {
        return table('projects', ['name', 'lang', 'stars'], function (r) {
          return { name: r.name, lang: r.lang, stars: r.stars };
        });
      }
      if (head === 'skills') return table('skills', ['name', 'category'], function (r) { return r; });
      if (head === 'contact') return table('contact', ['channel', 'handle'], function (r) {
        return { channel: r.channel, handle: r.handle };
      });

      // SQL and psql meta commands run straight from the shell
      if (/^(select|explain)\b/i.test(cmd) || cmd.charAt(0) === '\\') return null;

      return 'zsh: command not found: ' + cmd.split(/\s+/)[0] + '\nType help for what this shell knows.';
    }

    function submit(src) {
      if (!src.trim()) return;
      history.push(src); hi = history.length;
      write('cn-echo', (sqlMode ? PSQL : ZSH) + ' ' + src);
      var trimmed = src.trim();

      try {
        if (sqlMode && (trimmed === '\\q' || trimmed.toLowerCase() === 'exit')) {
          sqlMode = false; setPrompt();
          write('cn-res', 'Back in the shell.');
          return;
        }
        if (!sqlMode) {
          var r = runShell(src);
          if (r !== null) { write('cn-res', r); return; }
          if (!/^(select|explain)\b/i.test(trimmed) && trimmed.charAt(0) !== '\\') return;
        }
        if (trimmed.charAt(0) === '\\' || trimmed.toLowerCase() === 'help') {
          var m = meta(trimmed, tables, api);
          write('cn-res', m == null
            ? renderError(new SqlError('unrecognised command "' + trimmed + '"', -1, 'Try \\? for help.'), null)
            : m);
        } else {
          write('cn-res', execute(trimmed, tables).text);
        }
      } catch (e) {
        if (e instanceof SqlError) write('cn-err', renderError(e, trimmed.replace(/;+$/, '')));
        else write('cn-err', 'ERROR:  ' + (e && e.message ? e.message : 'unknown error'));
      }
    }

    input.addEventListener('keydown', function (e) {
      if (game) { e.preventDefault(); return; }
      if (e.key === 'Enter') { submit(input.value); input.value = ''; }
      else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = history[hi]; } e.preventDefault(); }
      else if (e.key === 'ArrowDown') { if (hi < history.length - 1) { hi++; input.value = history[hi]; } else { hi = history.length; input.value = ''; } e.preventDefault(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        var words = input.value.split(/\s+/), last = words[words.length - 1].toLowerCase();
        if (!last) return;
        var pool = ['about', 'work', 'projects', 'skills', 'contact', 'neofetch', 'snake', 'psql', 'help', 'clear']
          .concat(Object.keys(tables));
        Object.keys(tables).forEach(function (t) { pool = pool.concat(Object.keys(tables[t][0] || {})); });
        var hit = pool.filter(function (w) { return w.toLowerCase().indexOf(last) === 0; });
        if (hit.length === 1) { words[words.length - 1] = hit[0]; input.value = words.join(' '); }
        else if (hit.length > 1) write('cn-res', hit.join('   '));
      }
    });

    [].forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        submit(chip.dataset.q);
        input.value = '';
        chip.classList.add('done');
        input.focus();
      });
    });

    shell.addEventListener('click', function (e) {
      if (e.target.closest('.cn-chip') || window.getSelection().toString()) return;
      input.focus();
    });

    /* ── login banner, warm-up, then hand over ──────────────────── */

    setPrompt();

    function lastLogin() {
      var d = new Date(Date.now() - 864e5 * 2),
          days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
          two = function (n) { return (n < 10 ? '0' : '') + n; };
      return 'Last login: ' + days[d.getDay()] + ' ' + mons[d.getMonth()] + ' ' +
             (d.getDate() < 10 ? ' ' : '') + d.getDate() + ' ' +
             two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + ' on console';
    }

    var WARM = [
      ['mounting /career', '15 years'],
      ['warming up the warehouse', 'databricks'],
      ['restoring 46 repositories', 'ok'],
      ['connecting to bookmyshow', 'ok'],
      ['spawning shell', 'zsh']
    ];

    function warmUp(done) {
      write('cn-note', lastLogin());
      var line = write('cn-boot', ''), i = 0, buf = [];
      (function next() {
        if (i >= WARM.length) { setTimeout(done, reduced ? 0 : 180); return; }
        var w = WARM[i++];
        buf.push('[  ok  ] ' + dotfill(w[0], 32) + ' ' + w[1]);
        line.textContent = buf.join('\n');
        out.scrollTop = out.scrollHeight;
        setTimeout(next, reduced ? 0 : 130 + i * 35);
      })();
    }

    function ready() {
      var shared = new URLSearchParams(location.search).get('q');
      submit(shared || 'about');
    }

    warmUp(ready);

    window.__selftest = function () { return selftest(tables); };
  }

  /* ── mode switching ───────────────────────────────────────────── */

  function setMode(mode, opts) {
    opts = opts || {};
    document.documentElement.dataset.mode = mode;
    try { localStorage.setItem('vp-mode', mode); } catch (e) {}
    var seg = document.getElementById('mode-toggle');
    if (seg) {
      var tabs = seg.querySelectorAll('button'), ind = seg.querySelector('.seg-ind'), active = null;
      [].forEach.call(tabs, function (t) {
        var on = t.dataset.mode === mode;
        t.setAttribute('aria-selected', String(on));
        if (on) active = t;
      });
      if (active && ind) {
        ind.style.width = active.offsetWidth + 'px';
        ind.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)';
      }
    }
    if (!opts.silent) {
      window.scrollTo(0, 0);
      if (mode === 'console') {
        var i = document.querySelector('.cn-input');
        if (i) i.focus({ preventScroll: true });
      }
    }
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
    setMode(saved === 'cv' ? 'cv' : 'console', { silent: true });
    var seg = document.getElementById('mode-toggle');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var t = e.target.closest('button[data-mode]');
        if (t) setMode(t.dataset.mode);
      });
      // the indicator is measured, so re-measure when the layout changes
      window.addEventListener('resize', function () {
        setMode(document.documentElement.dataset.mode || 'console', { silent: true });
      });
    }
    boot();
  });
})();
