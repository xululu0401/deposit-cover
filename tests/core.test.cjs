/* 存款保障对账台 · 核心测试（node --test tests/core.test.cjs）
 * 覆盖：金额解析与整数「分」精确性（BigInt 独立对拍）、分组与封顶、覆盖率与零分母、
 *       判定分组阈值两侧、机构缺口闭式与暴力对拍、缺口恒等式、跨持有人在额度上的隔离、
 *       参考分散方案与「采用后敞口归零」的守恒/归零/非负三性质、非法输入、输出契约、
 *       确定性、不修改入参、内置场景锚点、敏感性单调性。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

const close = (a, b, eps) => {
  const tol = Math.max(eps === undefined ? 1e-9 : eps, Math.abs(b) * 1e-11);
  assert.ok(Math.abs(a - b) <= tol, `期望 ${a} ≈ ${b}（差 ${Math.abs(a - b)}，容差 ${tol}）`);
};
// 确定性随机数（便于复现）
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const cfgOf = (limit, rows) => {
  const n = C.normalize({ limit: String(limit), rows });
  assert.ok(n.ok, '输入应有效：' + JSON.stringify(rows) + ' → ' + n.errors.join('；'));
  return n.cfg;
};
const D = C.defaults;
const defCfg = () => cfgOf(D.limit, D.rows);

// ══ G1 金额解析与整数「分」精确性 ═════════════════════════════
test('G1-1 金额写法：千分位、万分位单位、全角、货币符号、留空与非法值', () => {
  const cases = [
    ['450000', 45000000], ['450,000', 45000000], ['￥450,000', 45000000], ['¥450000', 45000000],
    ['45万', 45000000], ['4.5万', 4500000], ['1.5万', 1500000], ['1亿', 10000000000],
    ['0', 0], ['0.01', 1], ['0.1', 10], ['1000000000000', 100000000000000],
    ['５００', 50000],                                   // 全角数字
    [' 1,000.05 ', 100005], ['1000.5', 100050], ['1000.50', 100050]
  ];
  cases.forEach(([s, want]) => assert.strictEqual(C.cents(s), want, s));
  ['abc', '', '  ', '-5', '1.234', '1e5', '5元', '--3', '1.2.3', null, undefined, NaN, Infinity]
    .forEach(s => assert.ok(Number.isNaN(C.cents(s)), '应判非法：' + String(s)));
  assert.ok(Number.isNaN(C.cents(1000000000001)), '超过 1e12 元应判非法');
});

test('G1-2 BigInt 精确对拍：300 组随机金额，cents() 与独立的 BigInt 十进制解析逐位相等', () => {
  const rnd = mulberry32(20261110);
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const whole = Math.floor(rnd() * 1e12);
    const fracTwo = Math.floor(rnd() * 100);
    const useFrac = rnd() < 0.5;
    const str = String(whole) + (useFrac ? '.' + String(fracTwo).padStart(2, '0') : '');
    const big = BigInt(whole) * 100n + BigInt(useFrac ? fracTwo : 0);
    if (big > BigInt(C.LIMITS.MAX_CENTS)) continue;
    const got = C.cents(str);
    assert.strictEqual(BigInt(got), big, str);
    n++;
  }
  assert.ok(n > 250, '有效样本 ' + n + ' 组');
});

test('G1-3 万 / 亿 单位也走 BigInt 对拍（含两位小数）', () => {
  const rnd = mulberry32(777);
  for (let i = 0; i < 120; i++) {
    const whole = Math.floor(rnd() * 900000) + 1;
    const frac = Math.floor(rnd() * 100);
    const str = String(whole) + '.' + String(frac).padStart(2, '0') + '万';
    const want = (BigInt(whole) * 100n + BigInt(frac)) * 10000n;
    if (want > BigInt(C.LIMITS.MAX_CENTS)) continue;
    assert.strictEqual(BigInt(C.cents(str)), want, str);
  }
});

test('G1-4 整数「分」相加不产生浮点误差：0.1 + 0.2 类与 1e12 量级', () => {
  assert.strictEqual(C.cents('0.1') + C.cents('0.2'), C.cents('0.3'));
  assert.strictEqual(C.cents('1000000000000') + C.cents('0.01'), 100000000000001);
  const cfg = cfgOf('1000', [{ holder: 'A', bank: 'B', type: '定期存款', principal: '0.1', interest: '0.2' }]);
  assert.strictEqual(cfg.rows[0].total, 30, '0.1 元 + 0.2 元 = 0.30 元');
});

// ══ G2 分组与封顶 ═════════════════════════════════════════════
test('G2-1 默认虚构场景：逐组锚点（手算）', () => {
  const r = C.analyze(defCfg());
  const g = k => r.groups.find(x => x.bank === k);
  assert.strictEqual(r.groups.length, 3, '合并后 3 组');
  assert.strictEqual(g('甲银行').nRows, 2, '同一机构两笔并成一组');
  assert.strictEqual(g('甲银行').total, 59000000);
  assert.strictEqual(g('甲银行').covered, 50000000);
  assert.strictEqual(g('甲银行').excess, 9000000);
  assert.strictEqual(g('乙银行').total, 51000000);
  assert.strictEqual(g('乙银行').covered, 50000000);
  assert.strictEqual(g('乙银行').excess, 1000000);
  assert.strictEqual(g('乙银行').principal, 48000000, '乙银行本金 480,000');
  assert.strictEqual(g('乙银行').interest, 3000000, '乙银行利息 30,000');
  assert.strictEqual(r.totals.deposit, 130500000);
  assert.strictEqual(r.totals.covered, 120500000);
  assert.strictEqual(r.totals.excess, 10000000);
  assert.strictEqual(r.totals.nondeposit, 45000000);
  assert.strictEqual(r.totals.all, 175500000);
  assert.strictEqual(r.totals.emax, 9000000);
  assert.strictEqual(r.totals.emaxHolder, '本人');
  assert.strictEqual(r.totals.emaxBank, '甲银行');
  assert.strictEqual(r.totals.groupCount, 3);
  assert.strictEqual(r.totals.holderCount, 2);
});

test('G2-2 机构名归一化：全角 / 空格 / 大小写差异视为同一机构', () => {
  const cfg = cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '100000', interest: '' },
    { holder: '本人', bank: ' 甲银行 ', type: '活期存款', principal: '100000', interest: '' },
    { holder: '本人', bank: '甲银行\u3000', type: '大额存单', principal: '100000', interest: '' },
    { holder: '本人', bank: 'ＡＢ　Bank', type: '定期存款', principal: '100000', interest: '' },
    { holder: '本人', bank: 'ab bank', type: '定期存款', principal: '100000', interest: '' }
  ]);
  const r = C.analyze(cfg);
  assert.strictEqual(r.groups.length, 2, '前三个并成一组，后两个（全角/大小写）并成一组');
  const jia = r.groups.find(g => g.bank === '甲银行');
  assert.strictEqual(jia.nRows, 3);
  assert.strictEqual(jia.total, 30000000);
});

test('G2-3 同名机构但持有人不同 → 不合并', () => {
  const cfg = cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '400000', interest: '' },
    { holder: '配偶', bank: '甲银行', type: '定期存款', principal: '400000', interest: '' }
  ]);
  const r = C.analyze(cfg);
  assert.strictEqual(r.groups.length, 2);
  assert.strictEqual(r.totals.deposit, 80000000);
  assert.strictEqual(r.totals.covered, 80000000, '两人各 40 万都在限额内');
  assert.strictEqual(r.totals.excess, 0);
});

test('G2-4 非存款类完全不并入组、不计入存款类合计', () => {
  const base = [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '400000', interest: '' }
  ];
  const a = C.analyze(cfgOf('500000', base));
  const b = C.analyze(cfgOf('500000', base.concat([
    { holder: '本人', bank: '甲银行', type: '银行理财', principal: '900000', interest: '' }
  ])));
  assert.strictEqual(b.totals.deposit, a.totals.deposit, '存款类合计不受影响');
  assert.strictEqual(b.totals.covered, a.totals.covered, '受保合计不受影响');
  assert.strictEqual(b.totals.excess, a.totals.excess, '敞口不受影响');
  assert.strictEqual(b.totals.nondeposit, 90000000);
  assert.strictEqual(b.totals.all, a.totals.all + 90000000);
  assert.strictEqual(b.groups.length, a.groups.length, '非存款类不产生组');
});

test('G2-5 封顶与敞口：受保 = min(合计, L)，敞口 = 超出部分（300 组随机）', () => {
  const rnd = mulberry32(4242);
  for (let i = 0; i < 300; i++) {
    const L = (Math.floor(rnd() * 20) + 1) * 50000;
    const rows = [], k = Math.floor(rnd() * 5) + 1;
    for (let j = 0; j < k; j++) {
      rows.push({
        holder: ['本人', '配偶', '父母'][Math.floor(rnd() * 3)],
        bank: ['甲银行', '乙银行', '丙银行'][Math.floor(rnd() * 3)],
        type: rnd() < 0.8 ? '定期存款' : '银行理财',
        principal: String(Math.floor(rnd() * 30) * 50000),
        interest: String(Math.floor(rnd() * 10) * 5000)
      });
    }
    const cfg = cfgOf(L, rows);
    const r = C.analyze(cfg);
    r.groups.forEach(g => {
      assert.strictEqual(g.covered, Math.min(g.total, L * 100), '组受保');
      assert.strictEqual(g.excess, Math.max(0, g.total - L * 100), '组敞口');
      assert.ok(g.covered >= 0 && g.excess >= 0);
    });
    const S = r.groups.reduce((s, g) => s + g.covered, 0);
    const E = r.groups.reduce((s, g) => s + g.excess, 0);
    const Dd = r.groups.reduce((s, g) => s + g.total, 0);
    assert.strictEqual(r.totals.deposit, Dd);
    assert.strictEqual(r.totals.covered, S);
    assert.strictEqual(r.totals.excess, E);
    assert.strictEqual(E, Dd - S, '敞口 = 存款类合计 − 受保合计');
  }
});

test('G2-6 单笔远大于限额：受保恰好等于限额，敞口等于超出部分', () => {
  const r = C.analyze(cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '大额存单', principal: '300万', interest: '' }
  ]));
  assert.strictEqual(r.totals.deposit, 300000000);
  assert.strictEqual(r.totals.covered, 50000000);
  assert.strictEqual(r.totals.excess, 250000000);
  assert.strictEqual(r.holders[0].needBanks, 6, '300 万 ÷ 50 万 = 6 家');
});

// ══ G3 覆盖率、零分母与判定分组 ═══════════════════════════════
test('G3-1 覆盖率闭式：covD = S/D，covT = S/T', () => {
  const r = C.analyze(defCfg());
  close(r.totals.covD, 120500000 / 130500000, 1e-15);
  close(r.totals.covT, 120500000 / 175500000, 1e-15);
  assert.ok(Math.abs(r.totals.covD - 0.9233716475095785) < 1e-12, '实际值 ' + r.totals.covD);
  assert.ok(Math.abs(r.totals.covT - 0.6866096866096866) < 1e-12, '实际值 ' + r.totals.covT);
});

test('G3-2 没有存款类资产：covD 为 null（不谎报 0%/100%），分组单独成一档', () => {
  const r = C.analyze(cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '银行理财', principal: '400000', interest: '' },
    { holder: '本人', bank: '乙银行', type: '公募基金', principal: '260000', interest: '' }
  ]));
  assert.strictEqual(r.totals.deposit, 0);
  assert.strictEqual(r.totals.covered, 0);
  assert.strictEqual(r.totals.excess, 0);
  assert.strictEqual(r.totals.covD, null);
  assert.strictEqual(r.totals.band, 'nodeposit');
  assert.strictEqual(r.totals.covT, 0, '全口径下确实一点都没保到');
  assert.strictEqual(r.groups.length, 0);
});

test('G3-3 全部金额为 0：合计为 0、分组为 empty、不产生 NaN', () => {
  const r = C.analyze(cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '0', interest: '0' }
  ]));
  assert.strictEqual(r.totals.deposit, 0);
  assert.strictEqual(r.totals.all, 0);
  assert.strictEqual(r.totals.covT, null);
  assert.strictEqual(r.totals.band, 'empty');
  assert.strictEqual(r.totals.emax, 0);
  assert.strictEqual(r.totals.conc, null);
  assert.strictEqual(r.holders[0].needBanks, 0, '没有钱就不需要机构');
  assert.strictEqual(r.holders[0].gapBanks, 0);
});

test('G3-4 判定分组阈值两侧（按 敞口 ÷ 全部资产）', () => {
  const at = (num, den, dep) => C.bandOf(num, den, dep === undefined ? 1 : dep);
  assert.strictEqual(at(0, 100).key, 'none');
  assert.strictEqual(at(1, 100).key, 'slight');        // 恰好 1% ≤ 10%
  assert.strictEqual(at(10, 100).key, 'slight');       // 恰好 10% 归入轻度
  assert.strictEqual(at(10.000001, 100).key, 'clear');
  assert.strictEqual(at(30, 100).key, 'clear');        // 恰好 30% 归入明显
  assert.strictEqual(at(30.000001, 100).key, 'high');
  assert.strictEqual(at(0, 0).key, 'empty');
  assert.strictEqual(at(0, 100, 0).key, 'nodeposit');
  // 端到端：默认场景落在「轻度」
  assert.strictEqual(C.analyze(defCfg()).totals.band, 'slight');
});

test('G3-6 极小但非零的覆盖率不能显示成 0.00%（本轮目检发现的缺陷）', () => {
  assert.strictEqual(C.pct(0.9233716475095785), '92.34%');
  assert.strictEqual(C.pct(0.00001), '0.0010%');
  assert.strictEqual(C.pct(0.0000075000002749823), '0.00075%');
  assert.strictEqual(C.pct(0.0001), '0.010%');
  assert.strictEqual(C.pct(0.005), '0.50%');
  assert.strictEqual(C.pct(0), '0.00%');
  assert.strictEqual(C.pct(1), '100.00%');
  assert.strictEqual(C.pct(null), '—');
  // 端到端：限额 1000 万、存款 5000 亿 → 覆盖率约 0.002%，必须仍能看出「不是 0」
  const r = C.analyze(cfgOf('10000000', [
    { holder: '本人', bank: '甲银行', type: '大额存单', principal: '500000000000', interest: '' }
  ]));
  const s = C.pct(r.totals.covD);
  assert.ok(s !== '0.00%', '存款类覆盖率不应显示为 0.00%，实际 ' + s);
  assert.ok(parseFloat(s) > 0, '应显示为正数：' + s);
  assert.strictEqual(s, '0.0020%');
});

test('G3-5 受保合计对限额单调不减、敞口对限额单调不增（150 组随机 × 12 档限额）', () => {
  const rnd = mulberry32(31337);
  for (let i = 0; i < 150; i++) {
    const rows = [], k = Math.floor(rnd() * 6) + 1;
    for (let j = 0; j < k; j++) {
      rows.push({
        holder: ['本人', '配偶'][Math.floor(rnd() * 2)],
        bank: ['甲', '乙', '丙', '丁'][Math.floor(rnd() * 4)],
        type: rnd() < 0.85 ? '定期存款' : '银行理财',
        principal: String(Math.floor(rnd() * 40) * 25000),
        interest: String(Math.floor(rnd() * 6) * 1000)
      });
    }
    const cfg = cfgOf('500000', rows);
    let prevS = -1, prevE = Infinity;
    for (let lim = 1; lim <= 12; lim++) {
      const c2 = { limit: lim * 100000 * 100, rows: cfg.rows };
      const g2 = C.groupOf(c2), s2 = C.summarize(c2, g2);
      assert.ok(s2.totals.covered >= prevS, '受保应不减：' + lim);
      assert.ok(s2.totals.excess <= prevE, '敞口应不增：' + lim);
      prevS = s2.totals.covered; prevE = s2.totals.excess;
    }
  }
});

// ══ G4 机构缺口 ═══════════════════════════════════════════════
test('G4-1 默认场景：本人需要 3 家（现在 2 家，差 1 家）；配偶 1 家已够', () => {
  const r = C.analyze(defCfg());
  const ben = r.holders.find(h => h.holder === '本人');
  const pei = r.holders.find(h => h.holder === '配偶');
  assert.strictEqual(ben.deposit, 110000000);
  assert.strictEqual(ben.curBanks, 2);
  assert.strictEqual(ben.needBanks, 3);
  assert.strictEqual(ben.gapBanks, 1);
  assert.strictEqual(ben.spare, 0, '本人名下两组都已超限，没有剩余空间');
  assert.strictEqual(pei.deposit, 20500000);
  assert.strictEqual(pei.curBanks, 1);
  assert.strictEqual(pei.needBanks, 1);
  assert.strictEqual(pei.gapBanks, 0);
  assert.strictEqual(pei.spare, 29500000, '配偶名下剩余 29.5 万');
});

test('G4-2 need = ceil(D/L)：与「枚举机构数 k，取使 k×L ≥ D 的最小 k」暴力对拍（300 组）', () => {
  const rnd = mulberry32(909);
  for (let i = 0; i < 300; i++) {
    const L = (Math.floor(rnd() * 10) + 1) * 100000;   // 10 万 – 100 万
    const rows = [], k = Math.floor(rnd() * 5) + 1;
    for (let j = 0; j < k; j++) {
      rows.push({
        holder: '本人', bank: 'B' + j,
        type: '定期存款',
        principal: String(Math.floor(rnd() * 60) * 10000),
        interest: ''
      });
    }
    const cfg = cfgOf(L, rows);
    const r = C.analyze(cfg);
    const Dv = r.holders[0].deposit;
    let brute = 0;
    if (Dv > 0) { brute = 1; while (brute * L * 100 < Dv) brute++; }
    assert.strictEqual(r.holders[0].needBanks, brute, 'D=' + Dv + ' L=' + L);
    assert.strictEqual(r.holders[0].curBanks, cfg.rows.length, '每组一家机构');
  }
});

test('G4-3 缺口恒等式：max(0,need−cur) = ceil(max(0,敞口−名下剩余空间)/L)（穷举 + 随机）', () => {
  const check = (amounts, L) => {
    const rows = amounts.map((a, i) => ({ holder: '本人', bank: 'B' + i, type: '定期存款', principal: String(a / 100), interest: '' }));
    const cfg = cfgOf(L / 100, rows);
    const r = C.analyze(cfg);
    const h = r.holders[0];
    assert.strictEqual(h.gapBanks, h.gapByFormula,
      '金额=' + JSON.stringify(amounts) + ' L=' + L + ' → gap=' + h.gapBanks + ' 公式=' + h.gapByFormula);
  };
  const L = 500000 * 100;
  let n = 0;
  for (let a = 1; a <= 6; a++) for (let b = 0; b <= 6; b++) for (let c = 0; c <= 6; c++) {
    const list = [a, b, c].map(x => x * 250000 * 100).filter(x => x > 0);
    if (!list.length) continue;
    check(list, L); n++;
  }
  for (let a = 1; a <= 12; a++) { check([a * 250000 * 100], L); n++; }
  const rnd = mulberry32(5150);
  for (let i = 0; i < 200; i++) {
    const k = Math.floor(rnd() * 4) + 1, list = [];
    for (let j = 0; j < k; j++) list.push((Math.floor(rnd() * 24) + 1) * 50000 * 100);
    check(list, L); n++;
  }
  assert.ok(n > 500, '共核对 ' + n + ' 例');
});

test('G4-4 额度按人算：别的持有人有剩余空间，也不能缩短本人的缺口', () => {
  const cfg = cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '1300000', interest: '' },
    { holder: '配偶', bank: '乙银行', type: '定期存款', principal: '100000', interest: '' }
  ]);
  const r = C.analyze(cfg);
  const ben = r.holders.find(h => h.holder === '本人');
  const pei = r.holders.find(h => h.holder === '配偶');
  assert.strictEqual(ben.needBanks, 3, '130 万 ÷ 50 万 向上取整 = 3');
  assert.strictEqual(ben.curBanks, 1);
  assert.strictEqual(ben.gapBanks, 2);
  assert.strictEqual(pei.spare, 40000000, '配偶有 40 万剩余空间');
  assert.strictEqual(r.plan.perHolder.find(p => p.holder === '本人').newBanks.length, 2,
    '配偶的剩余额度不能拿来用，本人仍需新开 2 家');
});

// ══ G5 参考分散方案与「采用」的闭环 ═══════════════════════════
test('G5-1 默认场景方案：甲转出 9 万、乙转出 1 万，都由新机构1 承接，只新开 1 家', () => {
  const r = C.analyze(defCfg());
  assert.strictEqual(r.plan.perHolder.length, 1, '只有本人需要动');
  const ph = r.plan.perHolder[0];
  assert.strictEqual(ph.holder, '本人');
  assert.deepStrictEqual(ph.newBanks, ['新机构1'], '同一持有人在多组之间要复用新机构');
  assert.strictEqual(r.plan.totalNewBanks, 1);
  const byBank = {};
  ph.transfers.forEach(t => { byBank[t.bank] = t; });
  assert.strictEqual(byBank['甲银行'].excess, 9000000);
  assert.strictEqual(byBank['乙银行'].excess, 1000000);
  const recvTotal = ph.transfers.reduce((s, t) => s + t.receivers.reduce((x, rc) => x + rc.amount, 0), 0);
  assert.strictEqual(recvTotal, 10000000, '接收金额合计 = 转出金额合计');
});

test('G5-2 已有未满机构优先承接，装不下才新开（构造样例）', () => {
  const cfg = cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '600000', interest: '' },
    { holder: '本人', bank: '乙银行', type: '定期存款', principal: '100000', interest: '' }
  ]);
  const r = C.analyze(cfg);
  const ph = r.plan.perHolder.find(p => p.holder === '本人');
  assert.strictEqual(ph.transfers[0].bank, '甲银行');
  assert.strictEqual(ph.transfers[0].excess, 10000000, '甲超出 10 万');
  assert.deepStrictEqual(ph.transfers[0].receivers.map(x => x.kind + ':' + x.label),
    ['existing:乙银行'], '全额由乙银行剩余的 40 万承接，不需要新开机构');
  assert.deepStrictEqual(ph.newBanks, []);
  assert.strictEqual(r.plan.totalNewBanks, 0);
});

test('G5-3 采用方案后：敞口归零、每组不超限额、金额非负、总额守恒（300 组随机）', () => {
  const rnd = mulberry32(2718);
  let applied = 0;
  for (let i = 0; i < 300; i++) {
    const L = (Math.floor(rnd() * 8) + 1) * 100000;
    const rows = [], k = Math.floor(rnd() * 5) + 1;
    for (let j = 0; j < k; j++) {
      rows.push({
        holder: ['本人', '配偶'][Math.floor(rnd() * 2)],
        bank: ['甲', '乙', '丙'][Math.floor(rnd() * 3)],
        type: rnd() < 0.8 ? '定期存款' : '银行理财',
        principal: String(Math.floor(rnd() * 50) * 20000),
        interest: String(Math.floor(rnd() * 8) * 5000)
      });
    }
    const cfg = cfgOf(L, rows);
    const r = C.analyze(cfg);
    const outRows = C.applyPlan(cfg, r);
    // 金额非负且合法（无论方案是否可落地，产出的行都必须合法）
    outRows.forEach(o => { const c = C.cents(o.principal); assert.ok(Number.isFinite(c) && c >= 0, '金额应非负：' + JSON.stringify(o)); });
    const n2 = C.normalize({ limit: String(L), rows: outRows });
    assert.ok(n2.ok, '方案产出的输入应合法：' + n2.errors.join('；') + ' 行数=' + outRows.length);
    assert.ok(outRows.length <= C.LIMITS.MAX_ROWS, '产出行数不超过上限');
    const r2 = C.analyze(n2.cfg);
    if (r.plan.applicable) {
      assert.strictEqual(r2.totals.excess, 0, '采用后不应再有敞口（第 ' + i + ' 组）');
      assert.ok(r2.groups.every(g => g.total <= r2.limit), '每组都不超限额');
      applied++;
    } else if (r.totals.excess === 0) {
      assert.strictEqual(r.plan.perHolder.length, 0, '没有敞口时不应有方案');
      assert.strictEqual(r.plan.reason, null);
    } else {
      assert.ok(r.plan.reason === 'rows' || r.plan.reason === 'banks', '有敞口却不可落地时必须给出原因');
      assert.strictEqual(JSON.stringify(outRows), JSON.stringify(C.applyPlan(cfg, r)), '不可落地时是幂等的空操作');
    }
    assert.strictEqual(r2.totals.deposit, r.totals.deposit, '存款类总额守恒');
    assert.strictEqual(r2.totals.nondeposit, r.totals.nondeposit, '非存款类不受影响');
    assert.strictEqual(r2.totals.all, r.totals.all, '全口径总额守恒');
    assert.ok(r2.plan.totalNewBanks === 0 || r2.groups.every(g => g.excess === 0) || !r.plan.applicable);
  }
  assert.ok(applied >= 60, '可落地并修复敞口的样本数 ' + applied);
  assert.ok(applied <= 300);
});

test('G5-4 新开机构数 = Σ 各持有人缺口；接收金额不超过限额', () => {
  const rnd = mulberry32(60606);
  for (let i = 0; i < 200; i++) {
    const L = (Math.floor(rnd() * 6) + 1) * 100000;
    const rows = [], k = Math.floor(rnd() * 6) + 1;
    for (let j = 0; j < k; j++) {
      rows.push({
        holder: ['A', 'B', 'C'][Math.floor(rnd() * 3)], bank: 'B' + Math.floor(rnd() * 4),
        type: '定期存款', principal: String(Math.floor(rnd() * 40) * 20000), interest: '0'
      });
    }
    const cfg = cfgOf(L, rows);
    const r = C.analyze(cfg);
    const sumGap = r.holders.reduce((s, h) => s + h.gapBanks, 0);
    // 机构数被上限截断时不再声称「等于缺口」（那种情况会显式给出 reason=banks）
    if (r.plan.reason !== 'banks') assert.strictEqual(r.plan.totalNewBanks, sumGap, '新开机构数应等于缺口合计');
    else assert.strictEqual(r.plan.applicable, false, '被截断的方案必须标为不可落地');
    r.plan.perHolder.forEach(p => {
      p.transfers.forEach(t => {
        const perNew = {};
        t.receivers.forEach(rc => { perNew[rc.label] = (perNew[rc.label] || 0) + rc.amount; });
        Object.keys(perNew).forEach(lb => assert.ok(perNew[lb] <= L * 100, '接收额不超过限额：' + lb + ' ' + perNew[lb]));
      });
    });
  }
});

test('G5-5 没有敞口时方案为空，采用后输入不变', () => {
  const cfg = cfgOf('500000', [
    { holder: '本人', bank: '甲银行', type: '定期存款', principal: '200000', interest: '' }
  ]);
  const r = C.analyze(cfg);
  assert.strictEqual(r.plan.perHolder.length, 0);
  assert.strictEqual(r.plan.totalNewBanks, 0);
  assert.strictEqual(r.plan.applicable, false);
  const out = C.applyPlan(cfg, r);
  const n2 = C.normalize({ limit: '500000', rows: out });
  assert.strictEqual(C.analyze(n2.cfg).totals.covered, r.totals.covered);
});

// ══ G6 输入校验 ═══════════════════════════════════════════════
test('G6-1 限额非法：空、0、负数、越界、带小数元、非数字', () => {
  const rows = [{ holder: '本人', bank: '甲银行', type: '定期存款', principal: '100000', interest: '' }];
  ['', '0', '-500000', '999', '10000001', '500000.5', 'abc'].forEach(v => {
    const n = C.normalize({ limit: v, rows });
    assert.ok(!n.ok, '限额「' + v + '」应判非法');
    assert.ok(n.errors.length >= 1);
  });
  ['1000', '500000', '10000000'].forEach(v => assert.ok(C.normalize({ limit: v, rows }).ok, '限额 ' + v + ' 应合法'));
});

test('G6-2 行数：0 行与超过 12 行都要报错', () => {
  assert.ok(!C.normalize({ limit: '500000', rows: [] }).ok, '0 行应报错');
  const many = [];
  for (let i = 0; i < 13; i++) many.push({ holder: '本人', bank: 'B' + i, type: '定期存款', principal: '1000', interest: '' });
  const n = C.normalize({ limit: '500000', rows: many });
  assert.ok(!n.ok);
  assert.ok(n.errors.join('').indexOf('12') >= 0);
  const ok12 = [];
  for (let i = 0; i < 12; i++) ok12.push({ holder: '本人', bank: 'B' + i, type: '定期存款', principal: '1000', interest: '' });
  assert.ok(C.normalize({ limit: '500000', rows: ok12 }).ok, '12 行应合法');
});

test('G6-3 金额非法：负数、三位小数、超上限、非数字、缺机构名、类型不在选项里', () => {
  const base = { holder: '本人', bank: '甲银行', type: '定期存款', principal: '100000', interest: '' };
  const bad = [
    Object.assign({}, base, { principal: '-100' }),
    Object.assign({}, base, { principal: '1.234' }),
    Object.assign({}, base, { principal: '1000000000001' }),
    Object.assign({}, base, { principal: '一百' }),
    Object.assign({}, base, { bank: '   ' }),
    Object.assign({}, base, { type: '股票' }),
    Object.assign({}, base, { interest: '-1' })
  ];
  bad.forEach((r, i) => {
    const n = C.normalize({ limit: '500000', rows: [r] });
    assert.ok(!n.ok, '第 ' + i + ' 组应判非法：' + JSON.stringify(r));
  });
});

test('G6-4 利息留空按 0；持有人留空按「本人」；本金 0 合法', () => {
  const n = C.normalize({ limit: '500000', rows: [{ holder: '', bank: '甲银行', type: '定期存款', principal: '0', interest: '' }] });
  assert.ok(n.ok);
  assert.strictEqual(n.cfg.rows[0].interest, 0);
  assert.strictEqual(n.cfg.rows[0].holder, '本人');
  assert.strictEqual(n.cfg.rows[0].total, 0);
});

test('G6-5 宽容写法：全角百分号/千分位/数字型金额都能吃下', () => {
  const n = C.normalize({ limit: 500000, rows: [{ holder: '本人', bank: '甲银行', type: '定期存款', principal: '1,000.50', interest: 200 }] });
  assert.ok(n.ok, n.errors.join('；'));
  assert.strictEqual(n.cfg.rows[0].total, 100050 + 20000);
});

// ══ G7 输出契约、确定性与内置场景 ═════════════════════════════
function walk(v, path, bad) {
  if (v === null || v === undefined) { if (v === undefined) bad.push(path + ' = undefined'); return; }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) bad.push(path + ' = ' + v);
    return;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return;
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']', bad)); return; }
  Object.keys(v).forEach(k => walk(v[k], path + '.' + k, bad));
}

test('G7-1 输出字段递归有效：没有 undefined / NaN / Infinity（多种输入）', () => {
  const inputs = [
    [D.limit, D.rows],
    ['200000', D.rows],
    ['500000', [{ holder: '本人', bank: '甲', type: '银行理财', principal: '100', interest: '' }]],
    ['500000', [{ holder: '本人', bank: '甲', type: '定期存款', principal: '0', interest: '0' }]],
    ['1000', [{ holder: '本人', bank: '甲', type: '定期存款', principal: '1000000000000', interest: '' }]],
    ['500000', [
      { holder: '一个很长的持有人名字', bank: '某省某某商业银行股份有限公司', type: '结构性存款', principal: '999999999999', interest: '999999999999' },
      { holder: '配偶', bank: '另一家', type: '储蓄型保险', principal: '1', interest: '' }
    ]]
  ];
  inputs.forEach(([lim, rows]) => {
    const n = C.normalize({ limit: lim, rows });
    assert.ok(n.ok, '输入应有效：' + n.errors.join('；'));
    const r = C.analyze(n.cfg);
    const bad = [];
    walk({ totals: r.totals, groups: r.groups, holders: r.holders, plan: r.plan, sensitivity: r.sensitivity, rowDiag: r.rowDiag, flags: r.flags }, 'r', bad);
    assert.deepStrictEqual(bad, []);
  });
});

test('G7-2 确定性：同一输入两次分析逐字节一致', () => {
  const a = JSON.stringify(C.analyze(defCfg()));
  const b = JSON.stringify(C.analyze(defCfg()));
  assert.strictEqual(a, b);
});

test('G7-3 不修改入参', () => {
  const cfg = defCfg();
  const snap = JSON.stringify(cfg);
  C.analyze(cfg);
  C.applyPlan(cfg, C.analyze(cfg));
  assert.strictEqual(JSON.stringify(cfg), snap);
});

test('G7-4 六个内置场景都能算通且锚点稳定', () => {
  const scenes = [
    { limit: '500000', rows: D.rows, covD: 0.9233716475095785, E: 10000000 },
    { limit: '500000', rows: [
      { holder: '本人', bank: '甲银行', type: '定期存款', principal: '200000', interest: '8000' },
      { holder: '本人', bank: '乙银行', type: '大额存单', principal: '300000', interest: '' },
      { holder: '本人', bank: '丙银行', type: '活期存款', principal: '50000', interest: '' }
    ], covD: 1, E: 0 },
    { limit: '500000', rows: [
      { holder: '本人', bank: '甲银行', type: '定期存款', principal: '1200000', interest: '200000' },
      { holder: '本人', bank: '乙银行', type: '活期存款', principal: '60000', interest: '' }
    ], E: 90000000 },
    { limit: '500000', rows: [
      { holder: '本人', bank: '甲银行', type: '大额存单', principal: '500000', interest: '40000' },
      { holder: '本人', bank: '乙银行', type: '定期存款', principal: '495000', interest: '22000' }
    ], E: 5700000 },
    { limit: '500000', rows: [
      { holder: '本人', bank: '甲银行', type: '银行理财', principal: '400000', interest: '' },
      { holder: '本人', bank: '乙银行', type: '公募基金', principal: '260000', interest: '' },
      { holder: '本人', bank: '丙银行', type: '储蓄型保险', principal: '180000', interest: '' }
    ], E: 0, band: 'nodeposit' },
    { limit: '200000', rows: [
      { holder: '本人', bank: '甲银行', type: '定期存款', principal: '450000', interest: '60000' },
      { holder: '本人', bank: '甲银行', type: '活期存款', principal: '80000', interest: '' },
      { holder: '本人', bank: '乙银行', type: '大额存单', principal: '480000', interest: '30000' },
      { holder: '配偶', bank: '乙银行', type: '定期存款', principal: '200000', interest: '5000' }
    ] }
  ];
  scenes.forEach((s, i) => {
    const cfg = cfgOf(s.limit, s.rows);
    const r = C.analyze(cfg);
    if (s.covD !== undefined) close(r.totals.covD, s.covD, 1e-12);
    if (s.E !== undefined) assert.strictEqual(r.totals.excess, s.E, '场景 ' + (i + 1) + ' 敞口');
    if (s.band) assert.strictEqual(r.totals.band, s.band);
    assert.ok(r.totals.covered + r.totals.excess === r.totals.deposit, '场景 ' + (i + 1) + ' 守恒');
  });
});

test('G7-5 敏感性：五档限额都与「用该限额直接重算」一致，且覆盖率单调不减', () => {
  const cfg = defCfg();
  const r = C.analyze(cfg);
  let prev = -1;
  r.sensitivity.forEach(s => {
    const c2 = { limit: s.limit, rows: cfg.rows };
    const s2 = C.summarize(c2, C.groupOf(c2));
    assert.strictEqual(s.covered, s2.totals.covered, '限额 ' + s.limit + ' 的受保应一致');
    assert.strictEqual(s.excess, s2.totals.excess);
    assert.strictEqual(s.covD, s2.totals.covD);
    assert.ok(s.covered >= prev, '覆盖率随限额不减');
    prev = s.covered;
  });
  assert.strictEqual(r.sensitivity.filter(s => s.current).length, 1, '应恰好标出一档当前限额');
  assert.strictEqual(r.sensitivity.find(s => s.current).limit, 500000 * 100);
});

test('G7-6 rowDiag 与逐组结果一致（每行都能指回它所属的组）', () => {
  const r = C.analyze(defCfg());
  r.rowDiag.forEach(x => {
    if (!x.isDeposit) { assert.strictEqual(x.group, null, '非存款类不属于任何组'); return; }
    const g = r.groups.find(g2 => g2.holder === x.holder && g2.bank === x.bank);
    assert.ok(g, '存款类行应能找到所属组');
    assert.strictEqual(x.group.total, g.total);
    assert.strictEqual(x.group.covered, g.covered);
    assert.strictEqual(x.group.excess, g.excess);
  });
  const sumDeposit = r.rowDiag.filter(x => x.isDeposit).reduce((s, x) => s + x.total, 0);
  assert.strictEqual(sumDeposit, r.totals.deposit, '存款类逐笔之和 = 存款类合计');
  const sumAll = r.rowDiag.reduce((s, x) => s + x.total, 0);
  assert.strictEqual(sumAll, r.totals.all, '逐笔之和 = 全口径合计');
});

test('G7-7 提示信息：利息顶出限额、同机构多笔、非存款类、他人额度不可用', () => {
  const r = C.analyze(defCfg());
  const keys = r.flags.map(f => f.key);
  assert.ok(keys.indexOf('interest') >= 0, '应提示利息把一组顶出限额');
  assert.ok(keys.indexOf('merge') >= 0, '应提示同机构多笔合并');
  assert.ok(keys.indexOf('nondeposit') >= 0, '应提示非存款类不在保障内');
  assert.ok(keys.indexOf('cross') >= 0, '应提示别人名下的剩余额度不能直接用');
  const f = r.flags.find(x => x.key === 'interest');
  assert.ok(f.text.indexOf('乙银行') >= 0, '利息提示应点名到具体机构');
});
