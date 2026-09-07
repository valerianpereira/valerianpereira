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

    t.projects = [].map.call(document.querySelectorAll('.builds:not(.ships) .build'), function (el) {
      return {
        name: el.dataset.name,
        lang: el.dataset.lang,
        stars: Number(el.dataset.stars || 0),
        url: el.dataset.url,
        blurb: el.dataset.blurb
      };
    });

    t.shipped = [].map.call(document.querySelectorAll('.ships .build'), function (el) {
      return { name: el.dataset.name, team: el.dataset.team, blurb: el.dataset.blurb };
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
      role: 'Head of Data Team',
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
      ['os', 'Data Team ' + yrs + '.0'],
      ['kernel', 'Head of Data Team'],
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
    'Valerian Pereira — Head of Data Team at BookMyShow, in Mumbai.',
    '',
    'Fifteen years building the things other people’s traffic runs on: data',
    'platforms, APIs, and the infrastructure underneath them. Today that runs three',
    'ways — the platform on Databricks and AWS, the analytics and reconciliation a',
    'ticketing business actually runs on, and data science.',
    '',
    'Nine of the things those teams shipped are in here: `select * from shipped;`.',
    '',
    'Before that, seven years at BookMyShow working up from writing the platform',
    'to running it, and four at Softaculous building hosting-control-panel software',
    'that shipped to other people’s servers.',
    '',
    'After hours I build small command-line tools — a GitHub Action that backs up',
    'databases, a World Cup tracker for the terminal, a shelf of Alexa skills —',
    'usually because some chore should have automated itself.',
    '',
    'This résumé is a database, and you are already in psql. Try `\\dt` for the tables,',
    '`select * from roles;` for the long version, or `\\?` for the rest.'
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
    '  ask <question> put it in plain English',
  '  pong           w/s to move, first to five',
    '',
    '  psql           open a SQL prompt against my career',
    '  clear          clear the screen',
    '',
    'SQL works from here too — type SELECT … and it just runs.'
  ].join('\n');

  /* ── ask ────────────────────────────────────────────────────────
     A scripted agent, not a model. Every answer below is written from the
     record on this page; nothing is generated and nothing leaves the browser.
     Questions about intent that only Valerian can answer (availability, rates)
     deliberately point at his inbox rather than putting words in his mouth. */

  var QA = [
    { k: ['what do you do', 'what does he do', 'role', 'job', 'title', 'current', 'work on'],
      a: 'He leads the Data team at BookMyShow — India\'s largest entertainment ticketing platform.\nThree groups report in: the data platform (Databricks and AWS, ingestion and warehousing),\nanalytics and the reporting the business runs on, and data science.\nRun `work` for the full run of roles.' },

    { k: ['experience', 'how long', 'years', 'seniority', 'background'],
      a: 'Fifteen years, all of it shipping. Four at Softaculous (2011–2015) building Webuzo, a\nhosting control panel that ran on other people\'s servers, then eleven at BookMyShow —\nstarting as a senior developer in 2015 and working up to Head of Data Team in 2024.\nRun `work` to see the whole ladder.' },

    { k: ['stack', 'technolog', 'tools', 'languages', 'tech'],
      a: 'Data: Databricks, Spark, Delta Lake, MySQL, MariaDB, Postgres, MongoDB, MSSQL, Redis.\nPlatform: AWS, Docker, Kubernetes, GitHub Actions, Jenkins, Linux.\nLanguages: TypeScript, JavaScript, Node, Python, PHP, Bash, SQL.\nRun `skills` for the categorised list.' },

    { k: ['project', 'open source', 'built', 'github', 'repo', 'backup-action'],
      a: 'backup-action is the one people actually use — a GitHub Action that backs up MySQL,\nMongoDB and Postgres over SSH, 54 stars and on the Marketplace. Alongside it: fifa-wc26\n(the World Cup in your terminal), an npx business card, and a shelf of Alexa skills.\nRun `projects`, or query it: SELECT * FROM projects ORDER BY stars DESC;' },

    { k: ['hire', 'why should', 'good at', 'strength', 'bring'],
      a: 'He has run the same platform from both ends — writing it, then owning it. That is rarer\nthan it sounds: the reporting and reconciliation systems he is responsible for are the\nones finance closes the books on, so correctness is not negotiable. He also still ships\nsmall tools himself, which tends to keep a manager honest about what the work costs.' },

    { k: ['available', 'open to work', 'hiring', 'looking', 'freelance', 'fractional', 'consult', 'rate'],
      a: 'That one is his to answer, not mine — I am a scripted agent and I would only be guessing.\nEmail valerianpereira25@gmail.com and ask him directly; he reads it.' },

    { k: ['contact', 'reach', 'email', 'get in touch', 'linkedin'],
      a: 'valerianpereira25@gmail.com is the fastest route. Also on GitHub (@valerianpereira),\nLinkedIn (in/valerianpereira) and X (@valerianper_era). Run `contact` for the table,\nor scan the QR on the CV to save the card.' },

    { k: ['where', 'location', 'based', 'mumbai', 'city', 'remote'],
      a: 'Mumbai, India. Has worked there his whole career — Softaculous in Andheri, then\nBookMyShow.' },

    { k: ['education', 'degree', 'study', 'college', 'university', 'certif'],
      a: 'MCA from Indira Gandhi National Open University (2013–2017) and a B.Sc. in Information\nTechnology from L. S. Raheja College, Mumbai University (2008–2011). Professional Scrum\nMaster I, and Google Cloud Architecture training. Run `psql` then SELECT * FROM education;' },

    { k: ['databricks', 'warehouse', 'pipeline', 'data platform', 'scale', 'etl'],
      a: 'The platform runs on Databricks over AWS: ingestion from the transactional estate into\nthe warehouse, the data operations around it, and the reporting layer the business and\nfinance teams query. Day to day that is as much about reconciliation and correctness as\nit is about throughput.' },

    { k: ['site', 'this website', 'how did you build', 'made this', 'built this'],
      a: 'Two files and no framework: one HTML document and one script. The CV you can switch to\nis the real document; this shell reads its data-* attributes, which is why the two can\nnever disagree. The SQL is a small hand-written tokeniser and evaluator — no library.' }
  ];

  var ASK_SUGS = [
    'what do you do?',
    'what is your stack?',
    'why should we hire you?',
    'are you open to work?',
    'tell me about your projects'
  ];

  function askAnswer(q) {
    var t = (q || '').toLowerCase();
    var best = null, bestScore = 0;
    QA.forEach(function (item) {
      var score = 0;
      item.k.forEach(function (k) { if (t.indexOf(k) > -1) score += k.length; });
      if (score > bestScore) { bestScore = score; best = item; }
    });
    if (best) return best.a;
    return 'I do not have a scripted answer for that one — I am a small keyword-matched agent,\n' +
           'not a language model. Try `help` for what the shell knows, `about` for the summary,\n' +
           'or email valerianpereira25@gmail.com and ask the man himself.';
  }

  function boot() {
    var shell = document.getElementById('console');
    if (!shell) return;

    var out = shell.querySelector('.cn-out'),
        input = shell.querySelector('.cn-input'),
        ps1 = shell.querySelector('.cn-ps1'),
        who = shell.querySelector('.who'),
        chips = shell.querySelectorAll('.cn-chip'),
        tables = buildTables(),
        history = [], hi = -1,
        sqlMode = true,
        game = null,
        reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;

    var ZSH = 'guest@valerianpereira.in ~ %';
    var PSQL = 'career=#';

    var api = { toCv: function () { setMode('cv'); } };

    function setPrompt() {
      ps1.textContent = sqlMode ? PSQL : ZSH;
      if (who) who.textContent = 'guest@valerianpereira.in \u2014 ' +
        (sqlMode ? 'psql' : 'zsh') + ' \u2014 80\u00d724';
    }

    function write(cls, text) {
      var el = document.createElement('pre');
      el.className = cls;
      el.textContent = text;
      out.appendChild(el);
      out.scrollTop = out.scrollHeight;
      return el;
    }

    /* Renders `code` spans as real elements — no markup ever goes through
       innerHTML, so answer text stays text. */
    function richInto(node, text) {
      text.split(/(`[^`]+`)/).forEach(function (part) {
        if (part.charAt(0) === '`' && part.length > 2) {
          var c = document.createElement('code');
          c.textContent = part.slice(1, -1);
          node.appendChild(c);
        } else if (part) {
          node.appendChild(document.createTextNode(part));
        }
      });
    }

    /* The working line, in the shape Claude Code shows in a terminal:
       `. Crunching... (1.2s . 7 rows)`. Cosmetic, so reduced-motion skips it. */
    var VERBS = ['Mulling', 'Crunching', 'Percolating', 'Warehousing', 'Rummaging', 'Pondering'];

    function working(unitFn, done) {
      if (reduced) { done(); return; }
      var el = write('cn-status', ''), t0 = Date.now(),
          verb = VERBS[Math.floor(Math.random() * VERBS.length)], frame = 0;
      var tick = setInterval(function () {
        var secs = ((Date.now() - t0) / 1000).toFixed(1);
        el.textContent = '\u00b7 ' + verb + '\u2026' + Array((frame++ % 4) + 1).join(' ') +
                         '  (' + secs + 's)';
        out.scrollTop = out.scrollHeight;
      }, 90);
      setTimeout(function () {
        clearInterval(tick);
        var secs = ((Date.now() - t0) / 1000).toFixed(1);
        el.textContent = '\u00b7 ' + verb + '\u2026 (' + secs + 's \u00b7 \u2193 ' + unitFn() + ')';
        done();
      }, 420 + Math.floor(Math.random() * 300));
    }

    /* ── pong ───────────────────────────────────────────────────────
       Rendered as a character grid in the output pane. Keys are captured
       while it runs and released on quit, so the prompt is never left in a
       state where typing does nothing. */

    var PW = 64, PH = 17, PADDLE = 4, TARGET = 5;

    function startPong() {
      if (game) return;

      var you = (PH - PADDLE) / 2,
          cpu = (PH - PADDLE) / 2,
          ball, sy = 0, sc = 0, over = false,
          up = false, down = false,
          pre = write('cn-game', ''), tick,
          seed = (Date.now() % 2147483646) + 1;

      function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

      function serve(dir) {
        ball = { x: PW / 2, y: PH / 2, vx: dir * 0.9, vy: (rnd() * 1.2 - 0.6) || 0.4 };
      }

      function draw(note) {
        var g = [], y, x;
        for (y = 0; y < PH; y++) { g.push(new Array(PW)); for (x = 0; x < PW; x++) g[y][x] = ' '; }
        for (y = 0; y < PH; y++) if (y % 2 === 0) g[y][Math.floor(PW / 2)] = '┊';
        for (y = 0; y < PADDLE; y++) {
          var a = Math.round(you) + y, b = Math.round(cpu) + y;
          if (a >= 0 && a < PH) g[a][1] = '█';
          if (b >= 0 && b < PH) g[b][PW - 2] = '█';
        }
        var bx = Math.round(ball.x), by = Math.round(ball.y);
        if (by >= 0 && by < PH && bx >= 0 && bx < PW) g[by][bx] = '●';

        var rule = Array(PW + 1).join('─');
        pre.textContent = [
          'pong  ·  w/s or ↑/↓ to move  ·  q to quit' +
            Array(Math.max(1, PW - 44)).join(' ') + '   you ' + sy + '  —  ' + sc + ' cpu',
          '┌' + rule + '┐'
        ].concat(g.map(function (r) { return '│' + r.join('') + '│'; }))
         .concat(['└' + rule + '┘', note || '']).join('\n');
        out.scrollTop = out.scrollHeight;
      }

      function step() {
        if (up) you -= 1.1;
        if (down) you += 1.1;
        you = Math.max(0, Math.min(PH - PADDLE, you));

        // the machine tracks the ball, but slowly enough to be beatable
        var target = ball.y - PADDLE / 2;
        cpu += Math.max(-0.78, Math.min(0.78, target - cpu));
        cpu = Math.max(0, Math.min(PH - PADDLE, cpu));

        ball.x += ball.vx;
        ball.y += ball.vy;
        if (ball.y <= 0) { ball.y = 0; ball.vy = Math.abs(ball.vy); }
        if (ball.y >= PH - 1) { ball.y = PH - 1; ball.vy = -Math.abs(ball.vy); }

        // paddles
        if (ball.x <= 2 && ball.vx < 0) {
          if (ball.y >= you - 0.5 && ball.y <= you + PADDLE) {
            ball.vx = Math.abs(ball.vx) * 1.03;
            ball.vy += (ball.y - (you + PADDLE / 2)) * 0.28;
            ball.x = 2;
          }
        }
        if (ball.x >= PW - 3 && ball.vx > 0) {
          if (ball.y >= cpu - 0.5 && ball.y <= cpu + PADDLE) {
            ball.vx = -Math.abs(ball.vx) * 1.03;
            ball.vy += (ball.y - (cpu + PADDLE / 2)) * 0.28;
            ball.x = PW - 3;
          }
        }

        if (ball.x < 0) { sc++; done('cpu scores.'); return; }
        if (ball.x > PW - 1) { sy++; done('you score.'); return; }
        draw();
      }

      function done(msg) {
        if (sy >= TARGET || sc >= TARGET) {
          over = true; stop();
          draw(sy > sc ? 'you win, ' + sy + '–' + sc + '. type pong to play again.'
                       : 'cpu wins, ' + sc + '–' + sy + '. type pong to play again.');
          return;
        }
        serve(ball.x < 0 ? 1 : -1);
        draw(msg);
      }

      function key(e) {
        var k = (e.key || '').toLowerCase();
        if (k === 'arrowup' || k === 'w') { up = true; down = false; e.preventDefault(); }
        else if (k === 'arrowdown' || k === 's') { down = true; up = false; e.preventDefault(); }
        else if (k === 'q' || k === 'escape') { e.preventDefault(); stop(); pre.textContent += '\nquit.'; }
      }
      function release(e) {
        var k = (e.key || '').toLowerCase();
        if (k === 'arrowup' || k === 'w') up = false;
        if (k === 'arrowdown' || k === 's') down = false;
      }

      function stop() {
        clearInterval(tick);
        document.removeEventListener('keydown', key, true);
        document.removeEventListener('keyup', release, true);
        game = null;
        input.focus();
      }

      game = { stop: stop };
      document.addEventListener('keydown', key, true);
      document.addEventListener('keyup', release, true);
      serve(rnd() > 0.5 ? 1 : -1);
      draw('first to ' + TARGET + '.');
      tick = setInterval(step, 55);
    }

    /* ── command dispatch ───────────────────────────────────────── */

    function renderAskIntro() {
      write('cn-ask-head', '\u2726 Ask valerian-ai');
      write('cn-ask-note',
        'A tiny scripted agent \u2014 no live model, no network, just curated answers written\n' +
        'from the record on this page. Ask in plain English, or tap one:');
      var wrap = document.createElement('div');
      wrap.className = 'cn-sugs';
      ASK_SUGS.forEach(function (q) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cn-sug';
        btn.textContent = '\u201c' + q + '\u201d';
        btn.addEventListener('click', function () { submit('ask ' + q); input.focus(); });
        wrap.appendChild(btn);
      });
      out.appendChild(wrap);
      out.scrollTop = out.scrollHeight;
    }

    function renderAnswer(q) {
      var box = document.createElement('div');
      box.className = 'cn-answer';
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = 'valerian-ai';
      var body = document.createElement('span');
      body.className = 'body';
      richInto(body, askAnswer(q));
      box.appendChild(who); box.appendChild(body);
      out.appendChild(box);
      out.scrollTop = out.scrollHeight;
    }

    function table(name, cols, map) {
      return renderTable({ cols: cols, rows: tables[name].map(map) });
    }

    function runShell(src) {
      var cmd = src.trim(), head = cmd.split(/\s+/)[0].toLowerCase();

      if (head === 'ask') {
        var q = cmd.replace(/^ask\s*/i, '').trim();
        if (!q) { renderAskIntro(); return null; }
        working(function () { return '1 answer'; }, function () { renderAnswer(q); });
        return null;
      }
      if (head === 'about') return ABOUT;
      if (head === 'help' || head === '?') return HELP_SH;
      if (head === 'whoami') return 'valerian — Head of Data Team at BookMyShow';
      if (head === 'neofetch') return neofetch(tables);
      if (head === 'clear') { out.textContent = ''; return null; }
      if (head === 'pong' || head === 'game') { startPong(); return null; }
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

    var SHELL_WORDS = /^(about|ask|neofetch|pong|game|whoami|clear|date|pwd|ls|sudo|logout)\b/i;

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
        if (!sqlMode || SHELL_WORDS.test(trimmed)) {
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
          var res = execute(trimmed, tables);
          var n = res.res ? res.res.rows.length : 0;
          working(function () { return n + ' row' + (n === 1 ? '' : 's'); },
                  function () { write('cn-res', res.text); });
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
        var pool = ['about', 'ask', 'neofetch', 'pong', 'clear', 'select', 'from', 'where',
                    'order by', 'limit', 'count', '\\dt', '\\d', '\\?', '\\q']
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
      ['opening career.db', 'psql']
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
    ok('current role is the data team', /Head of Data Team/.test(q('SELECT title FROM roles WHERE current').rows[0].title));
    ok('shipped table populated', tables.shipped.length > 0 && tables.shipped.every(function (r) {
      return r.name && r.team && r.blurb;
    }));
    // guards the .builds:not(.ships) scoping — only repos carry a url
    ok('shipped rows stay out of projects', tables.projects.every(function (r) { return !!r.url; }));
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
