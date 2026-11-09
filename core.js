/* 存款保障对账台 · core.js
 * 存款保险口径下的保障覆盖与集中敞口算术：
 *   输入   每人每家限额 L、若干行资产（持有人 / 机构 / 类型 / 本金 / 利息）
 *   分组   g = (持有人, 机构名归一化后) —— 同一机构的多笔合并成一组
 *   封顶   本息合计 A_g = Σ(本金 + 利息)；受保 B_g = min(A_g, L)；敞口 E_g = max(0, A_g − L)
 *   覆盖率 存款类 S / D 与全口径 S / T（D = 0 或 T = 0 时返回 null，不谎报 0%）
 *   缺口   need_h = ceil(D_h / L) 家机构才能装下该持有人的存款；gap_h = max(0, need_h − cur_h)
 *   方案   把每个超限组的超出部分转出：先填同一持有人还有额度的组，再新开机构（贪心，一种可行解）
 *   敏感性 L 取五档重算
 *   精确性 全部金额用整数「分」做精确算术（不经过浮点小数），测试里另用 BigInt 独立对拍
 * 纯计算、无 DOM、无网络；浏览器挂 window.AppCore，Node 下 module.exports。
 * 本页不做安全性评价、不给投资建议、不联网、不查任何机构的真实情况。
 */
(function (global) {
  'use strict';

  var LIMITS = {
    MIN_LIMIT: 1000,            // 元
    MAX_LIMIT: 10000000,        // 元
    MIN_ROWS: 1,
    MAX_ROWS: 12,
    MAX_YUAN: 1e12,             // 单笔金额上限（元）
    MAX_CENTS: 1e14,            // 单笔金额上限（分）
    MAX_HOLDER: 12,             // 持有人名长度
    MAX_BANK: 16,               // 机构名长度
    DEPOSIT_TYPES: ['活期存款', '定期存款', '大额存单', '通知存款', '结构性存款'],
    NON_DEPOSIT_TYPES: ['银行理财', '公募基金', '储蓄型保险', '贵金属/其他'],
    SENS_LIMITS: [200000, 300000, 500000, 800000, 1000000],
    BAND_SLIGHT: 0.10,
    BAND_CLEAR: 0.30,
    NEW_BANK_PREFIX: '新机构',
    MAX_PLAN_BANKS: 40
  };

  function err(msg) { var e = new Error(msg); e.userMessage = msg; return e; }

  // ── 文本归一化 ──────────────────────────────────────────────
  var FW = /[\uFF01-\uFF5E]/g;
  function toHalf(s) {
    return String(s).replace(FW, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  }
  // 机构名 / 持有人名的归一键：全角转半角、全角空格、折叠空白、去首尾、拉丁小写
  function normName(s) {
    return toHalf(s === null || s === undefined ? '' : s)
      .replace(/\u3000/g, ' ')
      .replace(/[\s\u00a0]+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function cleanName(s) {
    return toHalf(s === null || s === undefined ? '' : s)
      .replace(/\u3000/g, ' ')
      .replace(/[\s\u00a0]+/g, ' ')
      .trim();
  }

  // ── 金额解析：一律落到整数「分」 ─────────────────────────────
  function cents(v) {
    if (typeof v === 'number') {
      if (!isFinite(v) || v < 0) return NaN;
      var c = Math.round(v * 100);
      if (Math.abs(v * 100 - c) > 1e-6) return NaN;
      return (Number.isSafeInteger(c) && c <= LIMITS.MAX_CENTS) ? c : NaN;
    }
    if (v === null || v === undefined) return NaN;
    var t = toHalf(String(v)).trim();
    if (!t) return NaN;
    t = t.replace(/[¥￥,，\s_]/g, '');
    var mult = 1;
    if (/万$/.test(t)) { mult = 10000; t = t.slice(0, -1); }
    else if (/亿$/.test(t)) { mult = 100000000; t = t.slice(0, -1); }
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    if (t.replace('.', '').length > 16) return NaN;
    var parts = t.split('.');
    var frac = (parts[1] || '') + '00';
    var whole = Number(parts[0]);
    if (!isFinite(whole)) return NaN;
    var c2 = whole * 100 * mult + Number(frac.slice(0, 2)) * mult;
    if (!Number.isSafeInteger(c2) || c2 > LIMITS.MAX_CENTS) return NaN;
    return c2;
  }
  function blankCents(v) { return v === null || v === undefined || String(v).trim() === ''; }
  function yuan(c) { return c / 100; }

  // ── 展示格式化 ──────────────────────────────────────────────
  function money(c) {
    if (c === null || c === undefined || !isFinite(c)) return '—';
    var neg = c < 0; c = Math.abs(Math.round(c));
    var y = Math.floor(c / 100), f = c % 100;
    var s = String(y).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (f) s += '.' + (f < 10 ? '0' : '') + f;
    return (neg ? '-' : '') + '¥' + s;
  }
  function money0(c) {
    if (c === null || c === undefined || !isFinite(c)) return '—';
    var s = String(Math.round(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '¥' + s;
  }
  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    d = (d === undefined) ? 2 : d;
    var s = Math.abs(v) >= 1e15 ? v.toExponential(6) : v.toFixed(d);
    var p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  function pct(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    d = (d === undefined) ? 2 : d;
    var x = v * 100;
    // 极小但非零的百分比不能显示成 0.00%（那等于把「几乎没有」说成「没有」）
    if (x !== 0 && Math.abs(x) < 1) {
      var mag = Math.floor(Math.log10(Math.abs(x)));
      var dec = Math.min(10, Math.max(d, -mag + 1));
      return fmt(x, dec) + '%';
    }
    return fmt(x, d) + '%';
  }
  function div(a, b) { return b > 0 ? a / b : null; }

  // ── 输入归一化 ──────────────────────────────────────────────
  function normalize(raw) {
    var errors = [];
    raw = raw || {};
    var lc = cents(raw.limit);
    if (!isFinite(lc)) {
      errors.push('每人每家限额要填 1,000 – 10,000,000 之间的数字（元），当前为「' + String(raw.limit === undefined ? '' : raw.limit) + '」。');
      lc = NaN;
    } else if (lc < LIMITS.MIN_LIMIT * 100 || lc > LIMITS.MAX_LIMIT * 100) {
      errors.push('每人每家限额要在 1,000 – 10,000,000 元之间，当前为 ' + money(lc) + '。');
    } else if (lc % 100 !== 0) {
      errors.push('限额填整数元就好（当前为 ' + money(lc) + '）。');
    }

    var rowsIn = Array.isArray(raw.rows) ? raw.rows : [];
    if (rowsIn.length < LIMITS.MIN_ROWS) errors.push('至少要填 1 行资产。');
    if (rowsIn.length > LIMITS.MAX_ROWS) errors.push('最多支持 ' + LIMITS.MAX_ROWS + ' 行资产，当前 ' + rowsIn.length + ' 行。');

    var rows = [];
    rowsIn.slice(0, LIMITS.MAX_ROWS).forEach(function (r, i) {
      var n = i + 1;
      r = r || {};
      var holder = cleanName(r.holder);
      if (!holder) holder = '本人';
      var bank = cleanName(r.bank);
      var type = cleanName(r.type);
      if (LIMITS.DEPOSIT_TYPES.indexOf(type) < 0 && LIMITS.NON_DEPOSIT_TYPES.indexOf(type) < 0) {
        errors.push('第 ' + n + ' 行的产品类型「' + (r.type === undefined ? '' : String(r.type)) + '」不在可选项里。');
        type = '定期存款';
      }
      if (holder.length > LIMITS.MAX_HOLDER) errors.push('第 ' + n + ' 行的持有人名超过 ' + LIMITS.MAX_HOLDER + ' 字。');
      if (!bank) errors.push('第 ' + n + ' 行还没填机构名称。');
      else if (bank.length > LIMITS.MAX_BANK) errors.push('第 ' + n + ' 行的机构名超过 ' + LIMITS.MAX_BANK + ' 字。');

      var p = cents(r.principal);
      if (!isFinite(p)) {
        errors.push('第 ' + n + ' 行的本金要填 0 – 1,000,000,000,000 之间的数字（元，最多两位小数），当前为「' + String(r.principal === undefined ? '' : r.principal) + '」。');
        p = 0;
      }
      var it;
      if (blankCents(r.interest)) it = 0;
      else {
        it = cents(r.interest);
        if (!isFinite(it)) {
          errors.push('第 ' + n + ' 行的利息留空或填 0 – 1,000,000,000,000 之间的数字（元），当前为「' + String(r.interest) + '」。');
          it = 0;
        }
      }
      rows.push({
        i: rows.length, holder: holder, bank: bank, type: type,
        principal: p, interest: it, total: p + it,
        isDeposit: LIMITS.DEPOSIT_TYPES.indexOf(type) >= 0,
        holderKey: normName(holder), bankKey: normName(bank)
      });
    });

    var cfg = { limit: lc, rows: rows };
    return { ok: errors.length === 0, cfg: cfg, errors: errors };
  }

  // ── 分组与封顶 ──────────────────────────────────────────────
  function groupOf(cfg) {
    var map = {}, order = [];
    cfg.rows.forEach(function (r) {
      if (!r.isDeposit) return;
      var k = r.holderKey + '\u0000' + r.bankKey;
      if (!map[k]) {
        map[k] = {
          key: k, holderKey: r.holderKey, bankKey: r.bankKey,
          holder: r.holder, bank: r.bank, rows: [], nRows: 0,
          principal: 0, interest: 0, total: 0, covered: 0, excess: 0
        };
        order.push(k);
      }
      var g = map[k];
      g.rows.push(r.i); g.nRows++;
      g.principal += r.principal; g.interest += r.interest; g.total += r.total;
    });
    var groups = order.map(function (k) { return map[k]; });
    groups.forEach(function (g) {
      g.covered = Math.min(g.total, cfg.limit);
      g.excess = Math.max(0, g.total - cfg.limit);
    });
    // 非存款类（不并入任何组）
    var nd = cfg.rows.filter(function (r) { return !r.isDeposit; });
    var ndTotal = nd.reduce(function (s, r) { return s + r.total; }, 0);
    return { groups: groups, nondepositRows: nd, nondeposit: ndTotal };
  }

  function summarize(cfg, g) {
    var L = cfg.limit;
    var D = g.groups.reduce(function (s, x) { return s + x.total; }, 0);
    var S = g.groups.reduce(function (s, x) { return s + x.covered; }, 0);
    var E = g.groups.reduce(function (s, x) { return s + x.excess; }, 0);
    var N = g.nondeposit, T = D + N;

    // 逐持有人
    var hmap = {}, horder = [];
    g.groups.forEach(function (x) {
      if (!hmap[x.holderKey]) {
        hmap[x.holderKey] = {
          holderKey: x.holderKey, holder: x.holder,
          deposit: 0, covered: 0, excess: 0, curBanks: 0, spare: 0, groups: []
        };
        horder.push(x.holderKey);
      }
      var h = hmap[x.holderKey];
      h.deposit += x.total; h.covered += x.covered; h.excess += x.excess;
      h.curBanks++; h.groups.push(x);
      h.spare += Math.max(0, L - x.total);
    });
    var holders = horder.map(function (k) {
      var h = hmap[k];
      h.needBanks = h.deposit > 0 ? Math.ceil(h.deposit / L) : 0;
      h.gapBanks = Math.max(0, h.needBanks - h.curBanks);
      // 与「(敞口 − 可承接额度) ÷ 限额 向上取整」互相印证（测试里逐例对拍）
      h.gapByFormula = Math.ceil(Math.max(0, h.excess - h.spare) / L);
      return h;
    });
    holders.sort(function (a, b) { return b.deposit - a.deposit; });

    // 最大单点敞口
    var emax = 0, emaxG = null, biggest = null;
    g.groups.forEach(function (x) {
      if (x.excess > emax) { emax = x.excess; emaxG = x; }
      if (!biggest || x.total > biggest.total) biggest = x;
    });

    var band = bandOf(E, T, D);
    var totals = {
      limit: L, deposit: D, covered: S, excess: E, nondeposit: N, all: T,
      covD: div(S, D), covT: div(S, T),
      emax: emax, emaxHolder: emaxG ? emaxG.holder : null, emaxBank: emaxG ? emaxG.bank : null,
      conc: div(emax, T),
      band: band.key, bandText: band.text,
      biggest: biggest ? { holder: biggest.holder, bank: biggest.bank, total: biggest.total, times: biggest.total / L } : null,
      groupCount: g.groups.length,
      holderCount: holders.length
    };
    return { totals: totals, holders: holders };
  }

  function bandOf(E, T, D) {
    if (!(T > 0)) return { key: 'empty', text: '没有可计算的资产' };
    if (!(D > 0)) return { key: 'nodeposit', text: '没有存款类资产（全部不在保障口径内）' };
    if (E === 0) return { key: 'none', text: '全额在保障口径内' };
    var r = E / T;
    if (r <= LIMITS.BAND_SLIGHT) return { key: 'slight', text: '轻度敞口' };
    if (r <= LIMITS.BAND_CLEAR) return { key: 'clear', text: '明显敞口' };
    return { key: 'high', text: '高敞口' };
  }

  // ── 参考分散方案 ────────────────────────────────────────────
  // 逐持有人：把超限组的超出部分转出，先填同一持有人还有额度的组，再新开机构。
  // 这是「贪心填满额度」的一种可行方案，不是唯一解；跨持有人不共用额度。
  function pickFree(list) {
    for (var i = 0; i < list.length; i++) if (list[i].free > 0) return list[i];
    return null;
  }
  function planOf(cfg, groups, holders) {
    var L = cfg.limit;
    var ndRows = cfg.rows.filter(function (r) { return !r.isDeposit; }).length;
    var capped = false, totalNew = 0, perHolder = [];
    holders.forEach(function (h) {
      var mine = groups.filter(function (x) { return x.holderKey === h.holderKey; });
      var over = mine.filter(function (x) { return x.excess > 0; });
      if (!over.length) return;                       // 这一位不需要动
      var freeList = mine.filter(function (x) { return L - x.total > 0; })
        .map(function (x) { return { bank: x.bank, free: L - x.total }; })
        .sort(function (a, b) { return b.free - a.free; });
      var existingCapacity = freeList.reduce(function (s, f) { return s + f.free; }, 0);
      var newFree = [], newBanks = [], transfers = [], incomplete = false;
      over.sort(function (a, b) { return b.excess - a.excess; });
      over.forEach(function (x) {
        if (incomplete) return;
        var need = x.excess, recv = [];
        while (need > 0) {
          var t = pickFree(freeList);
          if (t) {
            var take = Math.min(t.free, need);
            recv.push({ kind: 'existing', label: t.bank, amount: take });
            t.free -= take; need -= take; continue;
          }
          var nb = pickFree(newFree);
          if (nb) {
            var take2 = Math.min(nb.free, need);
            recv.push({ kind: 'new', label: nb.name, amount: take2 });
            nb.free -= take2; need -= take2; continue;
          }
          // 闭式：还需要几家「满额」新机构，避免按家逐次循环（极大金额下的性能与可用性保护）
          var banks = Math.ceil(need / L);
          if (newFree.length + banks > LIMITS.MAX_PLAN_BANKS) { incomplete = true; break; }
          for (var b = 0; b < banks; b++) {
            var amt = Math.min(L, need);
            var name = LIMITS.NEW_BANK_PREFIX + (newFree.length + 1);
            newFree.push({ name: name, free: L - amt });
            newBanks.push(name);
            recv.push({ kind: 'new', label: name, amount: amt });
            need -= amt;
          }
        }
        if (!incomplete) transfers.push({ holder: x.holder, bank: x.bank, excess: x.excess, receivers: recv });
      });
      if (incomplete) { capped = true; transfers = []; newBanks = []; }
      totalNew += newBanks.length;
      perHolder.push({
        holder: h.holder, holderKey: h.holderKey,
        excess: h.excess, spare: h.spare, curBanks: h.curBanks,
        needBanks: h.needBanks, gapBanks: h.gapBanks,
        transfers: transfers, newBanks: newBanks,
        existingCapacity: existingCapacity
      });
    });
    var rowsAfter = groups.length + totalNew + ndRows;
    var reason = null;
    if (capped) reason = 'banks';
    else if (rowsAfter > LIMITS.MAX_ROWS) reason = 'rows';
    var hasTransfers = perHolder.some(function (x) { return x.transfers.length > 0; });
    return {
      applicable: !reason && hasTransfers,
      reason: reason, rowsAfter: rowsAfter,
      maxBanks: LIMITS.MAX_PLAN_BANKS, maxRows: LIMITS.MAX_ROWS,
      perHolder: perHolder, totalNewBanks: totalNew
    };
  }

  // 把参考方案落到输入行上（会合并同一机构的多笔为一行；非存款类行不动）
  function applyPlan(cfg, res) {
    var out = [], L = cfg.limit, plan = res.plan;
    var rowsOf = function () {
      return cfg.rows.map(function (r) {
        return { holder: r.holder, bank: r.bank, type: r.type, principal: String(yuan(r.principal)), interest: r.interest ? String(yuan(r.interest)) : '' };
      });
    };
    // 方案不可落地（要新开的机构数或改写后的行数超出上限）时，原样返回，绝不产出非法输入
    if (!plan || plan.applicable === false) return rowsOf();
    var raw = groupOf(cfg).groups;          // 原始分组（带 rows 索引与 dominantType 需要的行）
    var groupsByHolder = {};
    raw.forEach(function (x) {
      (groupsByHolder[x.holderKey] = groupsByHolder[x.holderKey] || []).push(x);
    });
    // 先处理存款类：每个持有人按其组顺序产出行
    var seenHolder = {};
    raw.forEach(function (x) {
      if (seenHolder[x.holderKey]) return;
      seenHolder[x.holderKey] = true;
      var ph = null;
      plan.perHolder.forEach(function (p) { if (p.holderKey === x.holderKey) ph = p; });
      var mine = groupsByHolder[x.holderKey];
      // 每组目标额：先取 min(组额, L)，再把超出部分按接收方加回去
      var target = {}, names = [], newNames = [];
      mine.forEach(function (g2) {
        target[g2.key] = Math.min(g2.total, L);
        names.push({ key: g2.key, bank: g2.bank, type: dominantType(cfg, g2), holder: g2.holder });
      });
      if (ph) {
        ph.transfers.forEach(function (tr) {
          var from = mine.filter(function (g2) { return g2.bank === tr.bank; })[0];
          if (!from) return;
          tr.receivers.forEach(function (rc) {
            if (rc.kind === 'existing') {
              var to = mine.filter(function (g2) { return g2.bank === rc.label; })[0];
              if (to) target[to.key] += rc.amount;
            } else {
              if (newNames.indexOf(rc.label) < 0) newNames.push(rc.label);
              var nk = 'NEW\u0000' + rc.label;
              target[nk] = (target[nk] || 0) + rc.amount;
            }
          });
        });
      }
      names.forEach(function (n) {
        if (target[n.key] > 0) out.push({ holder: n.holder, bank: n.bank, type: n.type, principal: String(yuan(target[n.key])), interest: '' });
      });
      newNames.forEach(function (nm) {
        var amt = target['NEW\u0000' + nm];
        if (amt > 0) out.push({ holder: x.holder, bank: nm, type: '定期存款', principal: String(yuan(amt)), interest: '' });
      });
    });
    // 非存款类原样保留
    cfg.rows.forEach(function (r) {
      if (!r.isDeposit) out.push({ holder: r.holder, bank: r.bank, type: r.type, principal: String(yuan(r.principal)), interest: r.interest ? String(yuan(r.interest)) : '' });
    });
    return out;
  }
  function dominantType(cfg, g) {
    var best = null;
    g.rows.forEach(function (i) {
      var r = cfg.rows[i];
      if (!best || r.total > best.total) best = r;
    });
    return best ? best.type : '定期存款';
  }

  // ── 主入口 ──────────────────────────────────────────────────
  function analyze(cfg) {
    var g = groupOf(cfg);
    var s = summarize(cfg, g);
    var plan = planOf(cfg, g.groups, s.holders);
    var d = g.groups.map(function (x) {
      return {
        holder: x.holder, bank: x.bank, rowIdx: x.rows.slice(), nRows: x.nRows,
        principal: x.principal, interest: x.interest, total: x.total,
        covered: x.covered, excess: x.excess,
        share: div(x.total, s.totals.deposit)
      };
    });
    d.sort(function (a, b) { return b.total - a.total; });
    var holders = s.holders.map(function (h) {
      return {
        holder: h.holder, deposit: h.deposit, covered: h.covered, excess: h.excess,
        curBanks: h.curBanks, needBanks: h.needBanks, gapBanks: h.gapBanks,
        gapByFormula: h.gapByFormula, spare: h.spare,
        covD: div(h.covered, h.deposit)
      };
    });

    var sens = LIMITS.SENS_LIMITS.map(function (lim) {
      var c2 = { limit: lim * 100, rows: cfg.rows };
      var g2 = groupOf(c2);
      var s2 = summarize(c2, g2);
      return {
        limit: lim * 100, current: lim * 100 === cfg.limit,
        covered: s2.totals.covered, excess: s2.totals.excess,
        covD: s2.totals.covD, covT: s2.totals.covT, emax: s2.totals.emax,
        needs: s2.holders.map(function (h) { return { holder: h.holder, needBanks: h.needBanks, gapBanks: h.gapBanks }; })
      };
    });

    return {
      input: cfg, limit: cfg.limit,
      groups: d, holders: holders, totals: s.totals,
      plan: plan, sensitivity: sens,
      rowDiag: cfg.rows.map(function (r) {
        var g2 = g.groups.filter(function (x) { return x.holderKey === r.holderKey && x.bankKey === r.bankKey && r.isDeposit; })[0];
        return {
          i: r.i, holder: r.holder, bank: r.bank, type: r.type, isDeposit: r.isDeposit,
          principal: r.principal, interest: r.interest, total: r.total,
          group: g2 ? { total: g2.total, covered: g2.covered, excess: g2.excess } : null
        };
      }),
      flags: flagsOf(cfg, g, s, plan)
    };
  }

  function flagsOf(cfg, g, s, plan) {
    var out = [], L = cfg.limit, T = s.totals;
    var interestEats = g.groups.filter(function (x) { return x.interest > 0 && x.total > L && x.principal <= L; });
    if (interestEats.length) {
      out.push({
        key: 'interest', level: 'warn',
        text: '有 ' + interestEats.length + ' 组是「本金没超、加利息就超了」：' + interestEats.map(function (x) {
          return x.holder + ' @ ' + x.bank + '（本金 ' + money(x.principal) + ' + 利息 ' + money(x.interest) + ' = ' + money(x.total) + '，超出 ' + money(x.excess) + '）';
        }).join('；') + '。偿付口径是本息合计，所以这部分利息不在限额之内。'
      });
    }
    var multi = g.groups.filter(function (x) { return x.nRows > 1; });
    if (multi.length) {
      out.push({
        key: 'merge', level: 'info',
        text: '有 ' + multi.length + ' 家机构在同一持有人名下开了多笔，保障额度是**合并**算一份的：' + multi.map(function (x) {
          return x.holder + ' @ ' + x.bank + '（' + x.nRows + ' 笔合计 ' + money(x.total) + '）';
        }).join('；') + '。'
      });
    }
    if (T.nondeposit > 0) {
      out.push({
        key: 'nondeposit', level: 'warn',
        text: '有 ' + money(T.nondeposit) + ' 是银行理财 / 基金 / 保险这类**不是存款**的产品，不在这套保障口径里（占全部资产的 ' + pct(div(T.nondeposit, T.all)) + '）。'
      });
    }
    var crossSpare = [];
    s.holders.forEach(function (a) {
      if (a.excess <= 0) return;
      s.holders.forEach(function (b) {
        if (b.holderKey !== a.holderKey && b.spare > 0) crossSpare.push(b.holder + ' 还有 ' + money(b.spare) + ' 的空间');
      });
    });
    if (crossSpare.length) {
      out.push({
        key: 'cross', level: 'info',
        text: '别的持有人名下还有空额度（' + crossSpare.join('；') + '），但额度是按人算的，**不能直接挪给本人用**——除非资金真的换了持有人。'
      });
    }
    if (T.biggest && T.biggest.times >= 2) {
      out.push({
        key: 'big', level: 'warn',
        text: '单家机构金额最大的组是 ' + T.biggest.holder + ' @ ' + T.biggest.bank + '，合计 ' + money(T.biggest.total) + '，达到限额的 ' + fmt(T.biggest.times, 2) + ' 倍。'
      });
    }
    return out;
  }

  var API = {
    LIMITS: LIMITS,
    cents: cents, yuan: yuan, blankCents: blankCents,
    normName: normName, cleanName: cleanName, toHalf: toHalf,
    normalize: normalize, groupOf: groupOf, summarize: summarize, bandOf: bandOf,
    planOf: planOf, applyPlan: applyPlan, analyze: analyze,
    money: money, money0: money0, fmt: fmt, pct: pct, div: div,
    defaults: {
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '定期存款', principal: '450000', interest: '60000' },
        { holder: '本人', bank: '甲银行', type: '活期存款', principal: '80000', interest: '' },
        { holder: '本人', bank: '乙银行', type: '大额存单', principal: '480000', interest: '30000' },
        { holder: '本人', bank: '丙银行', type: '银行理财', principal: '300000', interest: '' },
        { holder: '配偶', bank: '乙银行', type: '定期存款', principal: '200000', interest: '5000' },
        { holder: '配偶', bank: '甲银行', type: '银行理财', principal: '150000', interest: '' }
      ]
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.AppCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
