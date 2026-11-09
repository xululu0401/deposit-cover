/* 存款保障对账台 · ui.js
 * 输入表格（持有人 / 机构 / 类型 / 本金 / 利息）→ 立即重算 → 主结论、逐组明细、
 * 机构缺口、参考分散方案（可一键采用/还原）、敏感性、四种导出、保存与刷新恢复。
 * 所有展示数字均来自同一次 AppCore.analyze() 的输出。
 */
(function () {
  'use strict';
  var C = window.AppCore;
  var STORE = 'deposit-cover-v1';
  var APP = 'deposit-cover';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function my(c) { return C.money(c); }
  function m0(c) { return C.money0(c); }
  function pc(v, d) { return C.pct(v, d === undefined ? 2 : d); }
  function num(v, d) { return C.fmt(v, d === undefined ? 2 : d); }

  var TYPES = C.LIMITS.DEPOSIT_TYPES.concat(C.LIMITS.NON_DEPOSIT_TYPES);

  var SCENES = [
    {
      name: '默认：本人+配偶、四家银行',
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '定期存款', principal: '450000', interest: '60000' },
        { holder: '本人', bank: '甲银行', type: '活期存款', principal: '80000', interest: '' },
        { holder: '本人', bank: '乙银行', type: '大额存单', principal: '480000', interest: '30000' },
        { holder: '本人', bank: '丙银行', type: '银行理财', principal: '300000', interest: '' },
        { holder: '配偶', bank: '乙银行', type: '定期存款', principal: '200000', interest: '5000' },
        { holder: '配偶', bank: '甲银行', type: '银行理财', principal: '150000', interest: '' }
      ]
    },
    {
      name: '全部在限额内',
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '定期存款', principal: '200000', interest: '8000' },
        { holder: '本人', bank: '乙银行', type: '大额存单', principal: '300000', interest: '' },
        { holder: '本人', bank: '丙银行', type: '活期存款', principal: '50000', interest: '' }
      ]
    },
    {
      name: '一家机构独大',
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '定期存款', principal: '1200000', interest: '200000' },
        { holder: '本人', bank: '乙银行', type: '活期存款', principal: '60000', interest: '' }
      ]
    },
    {
      name: '本金没超、利息顶出限额',
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '大额存单', principal: '500000', interest: '40000' },
        { holder: '本人', bank: '乙银行', type: '定期存款', principal: '495000', interest: '22000' }
      ]
    },
    {
      name: '全是不能保的产品',
      limit: '500000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '银行理财', principal: '400000', interest: '' },
        { holder: '本人', bank: '乙银行', type: '公募基金', principal: '260000', interest: '' },
        { holder: '本人', bank: '丙银行', type: '储蓄型保险', principal: '180000', interest: '' }
      ]
    },
    {
      name: '限额调低到 20 万',
      limit: '200000',
      rows: [
        { holder: '本人', bank: '甲银行', type: '定期存款', principal: '450000', interest: '60000' },
        { holder: '本人', bank: '甲银行', type: '活期存款', principal: '80000', interest: '' },
        { holder: '本人', bank: '乙银行', type: '大额存单', principal: '480000', interest: '30000' },
        { holder: '配偶', bank: '乙银行', type: '定期存款', principal: '200000', interest: '5000' }
      ]
    }
  ];

  var model = { limit: '500000', rows: [] };
  var lastResult = null, undoRows = null, undoLimit = null;

  // ── 输入渲染 ────────────────────────────────────────────────
  function rowHtml(r, i) {
    var opts = TYPES.map(function (t) {
      return '<option value="' + esc(t) + '"' + (t === r.type ? ' selected' : '') + '>' + esc(t) + (C.LIMITS.DEPOSIT_TYPES.indexOf(t) >= 0 ? '（存款类）' : '（不在保障内）') + '</option>';
    }).join('');
    return '<div class="item" data-i="' + i + '">' +
      '<div class="gridin">' +
      '<label class="f"><span>持有人</span><input type="text" data-k="holder" value="' + esc(r.holder) + '" aria-label="第' + (i + 1) + '行持有人"></label>' +
      '<label class="f"><span>机构</span><input type="text" data-k="bank" value="' + esc(r.bank) + '" aria-label="第' + (i + 1) + '行机构"></label>' +
      '<label class="f"><span>产品类型</span><select data-k="type" aria-label="第' + (i + 1) + '行产品类型">' + opts + '</select></label>' +
      '<label class="f"><span>本金（元）</span><input type="text" inputmode="decimal" data-k="principal" value="' + esc(r.principal) + '" aria-label="第' + (i + 1) + '行本金"></label>' +
      '<label class="f"><span>利息（元，可留空）</span><input type="text" inputmode="decimal" data-k="interest" value="' + esc(r.interest) + '" aria-label="第' + (i + 1) + '行利息"></label>' +
      '</div>' +
      '<div class="buttons"><button type="button" class="mini" data-act="del" data-i="' + i + '" aria-label="删除第' + (i + 1) + '行">删除这一笔</button>' +
      '<button type="button" class="mini" data-act="dup" data-i="' + i + '" aria-label="复制第' + (i + 1) + '行">复制这一笔</button></div>' +
      '</div>';
  }
  function renderRows() {
    $('rows').innerHTML = model.rows.map(rowHtml).join('');
  }
  function renderFields() { $('limit').value = model.limit; }
  function readRows() {
    var out = [];
    Array.prototype.forEach.call($('rows').querySelectorAll('.item'), function (it) {
      var o = {};
      ['holder', 'bank', 'type', 'principal', 'interest'].forEach(function (k) {
        var el = it.querySelector('[data-k="' + k + '"]');
        o[k] = el ? el.value : '';
      });
      out.push(o);
    });
    return out;
  }
  function readInput() { model.limit = $('limit').value; model.rows = readRows(); }
  function writeInput(src) {
    model.limit = String(src.limit === undefined ? '500000' : src.limit);
    model.rows = (src.rows || []).map(function (r) {
      return {
        holder: r.holder === undefined ? '' : String(r.holder),
        bank: r.bank === undefined ? '' : String(r.bank),
        type: r.type === undefined ? '定期存款' : String(r.type),
        principal: r.principal === undefined ? '' : String(r.principal),
        interest: r.interest === undefined ? '' : String(r.interest)
      };
    });
    if (!model.rows.length) model.rows = C.defaults.rows.map(function (r) { return Object.assign({}, r); });
    renderFields(); renderRows();
  }
  function renderPresets() {
    $('presets').innerHTML = SCENES.map(function (s, i) {
      return '<button type="button" data-scene="' + i + '">' + esc(s.name) + '</button>';
    }).join('');
  }

  // ── 结果渲染 ────────────────────────────────────────────────
  function advice(r) {
    var out = [], T = r.totals;
    if (!(T.deposit > 0)) {
      out.push({ cls: 'act', html: '这份清单里<strong>没有任何存款类产品</strong>：' + my(T.nondeposit) + ' 全部是银行理财 / 基金 / 保险这类不在这套保障口径里的产品。存款类覆盖率因此不适用（显示「—」），不是 0% 也不是 100%。' });
      return out;
    }
    out.push({
      cls: 'key',
      html: '存款类一共 <strong>' + my(T.deposit) + '</strong>，其中 <strong>' + my(T.covered) + '</strong> 在限额之内（<strong>' + pc(T.covD) + '</strong>），<strong>' + my(T.excess) + '</strong> 在保障之外。'
    });
    if (T.excess > 0) {
      out.push({
        cls: 'act',
        html: '敞口最集中的一处是 <strong>' + esc(T.emaxHolder) + ' @ ' + esc(T.emaxBank) + '</strong> 的 <strong>' + my(T.emax) + '</strong>，占全部敞口的 ' + pc(T.emax / T.excess) + '、占全部资产的 ' + pc(T.conc) + '。'
      });
    } else {
      out.push({ cls: 'ok', html: '按你填的限额，现在<strong>所有存款类资产都在限额之内</strong>，没有敞口。' });
    }
    r.holders.forEach(function (h) {
      if (h.gapBanks > 0) {
        out.push({
          cls: 'act',
          html: '<strong>' + esc(h.holder) + '</strong> 名下存款类 ' + my(h.deposit) + '，按每个机构最多 ' + m0(r.limit) + ' 算，需要 <strong>' + h.needBanks + ' 家</strong>机构才能全额装下；现在只有 ' + h.curBanks + ' 家，<strong>还差 ' + h.gapBanks + ' 家</strong>。'
        });
      } else if (h.excess > 0) {
        out.push({
          cls: 'warn',
          html: '<strong>' + esc(h.holder) + '</strong> 的机构数已经够（' + h.curBanks + ' 家 ≥ 需要 ' + h.needBanks + ' 家），但钱<strong>没有摊开</strong>：把超出的 ' + my(h.excess) + ' 挪到名下还没满的机构就能补上。'
        });
      }
    });
    if (r.plan.totalNewBanks > 0) {
      out.push({
        cls: 'info',
        html: '参考方案要新开 <strong>' + r.plan.totalNewBanks + ' 家</strong>机构（' + r.plan.perHolder.map(function (p) { return esc(p.holder) + '：' + p.newBanks.map(esc).join('、'); }).join('；') + '）。这是贪心填满额度的一种可行做法，不是唯一解。'
      });
    }
    r.flags.forEach(function (f) { out.push({ cls: f.level === 'warn' ? 'warn' : 'info', html: f.text.replace(/\*\*/g, '') }); });
    out.push({
      cls: 'info',
      html: '这份账只回答「有多少在限额之内、敞口集中在哪一家」。它<strong>不评价任何机构是否安全</strong>，也不给该不该把钱取出来的建议。'
    });
    return out;
  }

  function renderResult(r) {
    var T = r.totals, h = [];
    var tagCls = T.band === 'none' ? 'good' : (T.band === 'high' ? 'bad' : (T.band === 'empty' || T.band === 'nodeposit' ? '' : 'warn'));

    h.push('<h2>结论</h2>');
    if (T.deposit > 0) {
      h.push('<div class="metric">存款类 ' + my(T.deposit) + ' 里，<strong>' + my(T.covered) + '</strong> 在限额之内，<br><strong class="' + (T.excess > 0 ? 'bad' : 'good') + '">' + my(T.excess) + '</strong> 在保障之外<span class="tag ' + tagCls + '">' + esc(T.bandText) + '</span></div>');
    } else {
      h.push('<div class="metric"><strong class="bad">没有存款类资产</strong><span class="tag">' + esc(T.bandText) + '</span></div>');
    }
    h.push('<div class="stats">' +
      '<div><strong>' + pc(T.covD) + '</strong><span>存款类覆盖率（受保 ÷ 存款类合计）</span></div>' +
      '<div><strong>' + pc(T.covT) + '</strong><span>全口径覆盖率（受保 ÷ 含非存款类的全部资产）</span></div>' +
      '<div><strong>' + my(T.excess) + '</strong><span>保障之外的敞口</span></div>' +
      '<div><strong>' + (T.emax > 0 ? my(T.emax) : '—') + '</strong><span>最大单点敞口' + (T.emax > 0 ? '（' + esc(T.emaxHolder) + ' @ ' + esc(T.emaxBank) + '）' : '') + '</span></div>' +
      '<div><strong>' + my(T.all) + '</strong><span>全部资产（存款类 ' + my(T.deposit) + ' + 非存款类 ' + my(T.nondeposit) + '）</span></div>' +
      '<div><strong>' + T.groupCount + ' 组 / ' + T.holderCount + ' 人</strong><span>按「持有人 × 机构」合并后的组数</span></div>' +
      '</div>');

    h.push('<ul class="advice">');
    advice(r).forEach(function (a) { h.push('<li class="' + a.cls + '">' + a.html + '</li>'); });
    if (T.excess > 0 || undoRows) {
      var planNote = '';
      if (!r.plan.applicable && r.plan.reason === 'rows') {
        planNote = '<div class="mini"><span class="warn">这个方案会把输入改写成 ' + r.plan.rowsAfter + ' 行，超过本页 ' + r.plan.maxRows + ' 行的上限，所以不能一键采用。先把同一机构的多笔并成一笔，或减少持有人/机构数量，再看能不能落地。</span></div>';
      } else if (!r.plan.applicable && r.plan.reason === 'banks') {
        planNote = '<div class="mini"><span class="warn">这个方案要新开超过 ' + r.plan.maxBanks + ' 家机构，已经超出本页一次能给出的范围，所以不能一键采用。先确认金额和限额是不是填错了（比如少写或多写了一个 0）。</span></div>';
      } else if (r.plan.applicable) {
        planNote = '<div class="mini"><button type="button" id="applyPlan" class="primary">按建议分散（会改输入）</button></div>';
      }
      if (undoRows) planNote += '<div class="mini"><button type="button" id="undoPlan">还原上一版输入</button></div>';
      h.push('<li class="key">' + (T.excess > 0 ? '参考方案：' + planText(r) : '已按参考方案改写过输入：现在这套清单已经没有敞口了。') + planNote + '</li>');
    }
    h.push('</ul>');

    // 逐组结构
    h.push('<h3>逐组结构（同一机构的多笔已经合并）</h3>');
    var maxShare = r.groups.reduce(function (m, g) { return Math.max(m, g.share || 0); }, 0) || 1;
    r.groups.forEach(function (g) {
      var w = Math.max(2, Math.round((g.share || 0) / maxShare * 100));
      h.push('<div class="barrow"><b>' + esc(g.holder) + ' @ ' + esc(g.bank) + '</b>' +
        '<span class="bar"><i class="' + (g.excess > 0 ? 'exc' : 'cov') + '" style="width:' + w + '%"></i></span>' +
        '<span>' + my(g.total) + (g.excess > 0 ? ' · <span class="bad">敞口 ' + my(g.excess) + '</span>' : ' · 全额在内') + '</span></div>');
    });
    h.push('<div class="tw"><table class="stack"><thead><tr><th>持有人</th><th>机构</th><th>笔数</th><th>本金</th><th>利息</th><th>本息合计</th><th>受保</th><th>敞口</th><th>占存款类</th></tr></thead><tbody>');
    r.groups.forEach(function (g) {
      h.push('<tr><td data-label="持有人">' + esc(g.holder) + '</td><td data-label="机构">' + esc(g.bank) + '</td><td data-label="笔数" class="num">' + g.nRows + '</td>' +
        '<td data-label="本金" class="num">' + my(g.principal) + '</td><td data-label="利息" class="num">' + my(g.interest) + '</td>' +
        '<td data-label="本息合计" class="num">' + my(g.total) + '</td><td data-label="受保" class="num">' + my(g.covered) + '</td>' +
        '<td data-label="敞口" class="num">' + (g.excess > 0 ? '<span class="bad">' + my(g.excess) + '</span>' : '0') + '</td>' +
        '<td data-label="占存款类" class="num">' + pc(g.share) + '</td></tr>');
    });
    h.push('</tbody></table></div>');

    // 机构缺口
    h.push('<h3>要装下这些钱，需要几家机构</h3>');
    h.push('<div class="tw"><table class="stack"><thead><tr><th>持有人</th><th>存款类合计</th><th>现有机构数</th><th>最少需要</th><th>还差</th><th>名下剩余空间</th><th>该人覆盖率</th></tr></thead><tbody>');
    r.holders.forEach(function (x) {
      h.push('<tr><td data-label="持有人">' + esc(x.holder) + '</td><td data-label="存款类合计" class="num">' + my(x.deposit) + '</td>' +
        '<td data-label="现有机构数" class="num">' + x.curBanks + '</td><td data-label="最少需要" class="num">' + x.needBanks + '</td>' +
        '<td data-label="还差" class="num">' + (x.gapBanks > 0 ? '<span class="bad">' + x.gapBanks + ' 家</span>' : '0') + '</td>' +
        '<td data-label="名下剩余空间" class="num">' + my(x.spare) + '</td><td data-label="该人覆盖率" class="num">' + pc(x.covD) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    h.push('<p class="note">「最少需要」= 该持有人存款类合计 ÷ 每个机构的限额，向上取整；这是金额可以自由拆分时的下界。名下剩余空间只统计<strong>同一个人</strong>还没用满的额度，别人的额度不能直接挪过来。</p>');

    // 敏感性
    h.push('<h3>限额取不同值时</h3>');
    h.push('<div class="tw"><table class="stack"><thead><tr><th>每人每家限额</th><th>存款类覆盖率</th><th>全口径覆盖率</th><th>敞口</th><th>最大单点敞口</th><th>最少机构数（按持有人）</th></tr></thead><tbody>');
    r.sensitivity.forEach(function (s) {
      h.push('<tr' + (s.current ? ' class="cur"' : '') + '><td data-label="每人每家限额" class="num">' + m0(s.limit) + (s.current ? '（当前）' : '') + '</td>' +
        '<td data-label="存款类覆盖率" class="num">' + pc(s.covD) + '</td><td data-label="全口径覆盖率" class="num">' + pc(s.covT) + '</td>' +
        '<td data-label="敞口" class="num">' + my(s.excess) + '</td><td data-label="最大单点敞口" class="num">' + my(s.emax) + '</td>' +
        '<td data-label="最少机构数">' + s.needs.map(function (n) { return esc(n.holder) + ' ' + n.needBanks + ' 家'; }).join('，') + '</td></tr>');
    });
    h.push('</tbody></table></div>');

    h.push('<details class="model"><summary>算法与使用边界</summary>' + modelText() + '</details>');
    $('resultBody').innerHTML = h.join('');
    bindResult();
  }

  function planText(r) {
    var segs = [];
    r.plan.perHolder.forEach(function (p) {
      p.transfers.forEach(function (t) {
        segs.push(esc(t.holder) + ' 把 <strong>' + esc(t.bank) + '</strong> 的 <strong>' + my(t.excess) + '</strong> 转出 → ' +
          t.receivers.map(function (rc) { return esc(rc.label) + '（' + (rc.kind === 'new' ? '新开' : '名下未满') + '）' + my(rc.amount); }).join('，'));
      });
    });
    return segs.length ? segs.join('；') + '。' : '现在没有需要转出的钱。';
  }

  function modelText() {
    return '<p><strong>怎么算的</strong>：① 先按「持有人 + 机构名归一化后」把存款类合并成组（同一家银行的多笔算一组）；② 每组本息合计 = Σ(本金 + 利息)，受保 = min(本息合计, 限额)，敞口 = 超出部分；③ 存款类覆盖率 = 受保合计 ÷ 存款类合计；全口径覆盖率 = 受保合计 ÷ （存款类 + 非存款类）；④ 某持有人「最少机构数」= 该人存款类合计 ÷ 限额 向上取整；⑤ 参考方案把超限组的超出部分先填给同一持有人还有额度的组，再新开机构，是贪心的一种可行解，不是唯一解。</p>' +
      '<p><strong>刻意保守的设定</strong>：额度按人算，<strong>不同持有人的剩余额度不能互相占用</strong>（现实中把配偶的额度算给本人，要资金真的换了持有人才成立）。金额一律用整数「分」计算，不走浮点小数。</p>' +
      '<p><strong>做不到的事</strong>：不做汇率与外币存款；不处理联名账户、共有存款、家庭共有额度的归属争议；不查任何机构的法人名录，<strong>名字相同即视为同一机构、名字不同即视为不同机构</strong>（同一集团下的母行与村镇银行在现实中是不同法人，需要你自己填成两个名字）；不处理企业存款、同业存款、外币存款、大额存单转让；不算利息税；<strong>不预测任何机构的经营状况，不做安全性评价，不给「该不该取出来」的建议</strong>；不联网，也不判断某个产品是否受保。</p>' +
      '<p><strong>分类由你决定</strong>：下拉框里「存款类 / 不在保障内」只是你的选择。某个产品到底属于哪一类，以你手上的产品文件与官方规定为准。</p>' +
      '<p><strong>判定分组只是显示分组</strong>：全额在保障内 / 轻度 / 明显 / 高敞口，是按「敞口 ÷ 全部资产」分的展示档位，不是法规边界，也不是风险评估。默认样例与内置场景全部是虚构示例，不代表任何真实的人、机构或产品。</p>';
  }

  // ── 导出文本 ────────────────────────────────────────────────
  function csvText(r) {
    var L = [];
    var q = function (s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    L.push('存款保障对账台 · 导出（全部金额单位：元；本页不联网、不评价任何机构）');
    L.push('每人每家限额,' + C.yuan(r.limit));
    L.push('');
    L.push('【一、逐笔输入】');
    L.push('序号,持有人,机构,产品类型,是否存款类,本金,利息,本息合计');
    r.rowDiag.forEach(function (x) {
      L.push([x.i + 1, q(x.holder), q(x.bank), q(x.type), x.isDeposit ? '是' : '否', C.yuan(x.principal), C.yuan(x.interest), C.yuan(x.total)].join(','));
    });
    L.push('');
    L.push('【二、逐组（持有人 × 机构）】');
    L.push('持有人,机构,笔数,本金,利息,本息合计,受保,敞口,占存款类');
    r.groups.forEach(function (g) {
      L.push([q(g.holder), q(g.bank), g.nRows, C.yuan(g.principal), C.yuan(g.interest), C.yuan(g.total), C.yuan(g.covered), C.yuan(g.excess), (g.share === null ? '—' : (g.share * 100).toFixed(4) + '%')].join(','));
    });
    L.push('');
    L.push('【三、汇总】');
    L.push('存款类合计,' + C.yuan(r.totals.deposit));
    L.push('受保合计,' + C.yuan(r.totals.covered));
    L.push('敞口合计,' + C.yuan(r.totals.excess));
    L.push('存款类覆盖率,' + (r.totals.covD === null ? '不适用（无存款类资产）' : (r.totals.covD * 100).toFixed(6) + '%'));
    L.push('非存款类合计,' + C.yuan(r.totals.nondeposit));
    L.push('全部资产,' + C.yuan(r.totals.all));
    L.push('全口径覆盖率,' + (r.totals.covT === null ? '不适用' : (r.totals.covT * 100).toFixed(6) + '%'));
    L.push('最大单点敞口,' + C.yuan(r.totals.emax) + (r.totals.emax > 0 ? (',' + q(r.totals.emaxHolder + ' @ ' + r.totals.emaxBank)) : ''));
    L.push('判定分组,' + q(r.totals.bandText));
    L.push('');
    L.push('【四、机构缺口】');
    L.push('持有人,存款类合计,现有机构数,最少需要,还差,名下剩余空间,该人覆盖率');
    r.holders.forEach(function (x) {
      L.push([q(x.holder), C.yuan(x.deposit), x.curBanks, x.needBanks, x.gapBanks, C.yuan(x.spare), (x.covD === null ? '—' : (x.covD * 100).toFixed(4) + '%')].join(','));
    });
    L.push('');
    L.push('【五、参考分散方案（贪心的一种可行解）】');
    L.push('持有人,转出机构,转出金额,接收方,接收方类型,接收金额');
    r.plan.perHolder.forEach(function (p) {
      p.transfers.forEach(function (t) {
        t.receivers.forEach(function (rc) {
          L.push([q(t.holder), q(t.bank), C.yuan(t.excess), q(rc.label), rc.kind === 'new' ? '新开机构' : '名下未满', C.yuan(rc.amount)].join(','));
        });
      });
    });
    L.push('');
    L.push('【六、限额敏感性】');
    L.push('限额,存款类覆盖率,全口径覆盖率,敞口,最大单点敞口,最少机构数');
    r.sensitivity.forEach(function (s) {
      L.push([C.yuan(s.limit), (s.covD === null ? '—' : (s.covD * 100).toFixed(4) + '%'), (s.covT === null ? '—' : (s.covT * 100).toFixed(4) + '%'), C.yuan(s.excess), C.yuan(s.emax),
        q(s.needs.map(function (n) { return n.holder + ' ' + n.needBanks + ' 家'; }).join('，'))].join(','));
    });
    return L.join('\n');
  }

  function mdText(r) {
    var L = [], T = r.totals;
    L.push('# 存款保障对账台 · 结果说明');
    L.push('');
    L.push('> 导出时间：' + new Date().toISOString() + '；金额单位：元。本页不联网，不评价任何机构是否安全。');
    L.push('');
    L.push('## 一、结论');
    L.push('');
    L.push('- 每人每家限额：**' + m0(r.limit) + '**');
    L.push('- 存款类合计 **' + my(T.deposit) + '**，受保 **' + my(T.covered) + '**，敞口 **' + my(T.excess) + '**');
    L.push('- 存款类覆盖率 **' + pc(T.covD) + '**；全口径覆盖率 **' + pc(T.covT) + '**（含非存款类 ' + my(T.nondeposit) + '）');
    L.push('- 最大单点敞口 **' + my(T.emax) + '**' + (T.emax > 0 ? '（' + T.emaxHolder + ' @ ' + T.emaxBank + '）' : '') + '；判定分组：' + T.bandText);
    L.push('');
    L.push('## 二、逐组明细');
    L.push('');
    L.push('| 持有人 | 机构 | 笔数 | 本金 | 利息 | 本息合计 | 受保 | 敞口 |');
    L.push('|---|---|---|---|---|---|---|---|');
    r.groups.forEach(function (g) {
      L.push('| ' + g.holder + ' | ' + g.bank + ' | ' + g.nRows + ' | ' + my(g.principal) + ' | ' + my(g.interest) + ' | ' + my(g.total) + ' | ' + my(g.covered) + ' | ' + my(g.excess) + ' |');
    });
    L.push('');
    L.push('## 三、机构缺口');
    L.push('');
    L.push('| 持有人 | 存款类合计 | 现有机构数 | 最少需要 | 还差 | 名下剩余空间 |');
    L.push('|---|---|---|---|---|---|');
    r.holders.forEach(function (x) {
      L.push('| ' + x.holder + ' | ' + my(x.deposit) + ' | ' + x.curBanks + ' | ' + x.needBanks + ' | ' + x.gapBanks + ' | ' + my(x.spare) + ' |');
    });
    L.push('');
    L.push('## 四、参考分散方案（贪心的一种可行解，不是唯一解）');
    L.push('');
    r.plan.perHolder.forEach(function (p) {
      p.transfers.forEach(function (t) {
        t.receivers.forEach(function (rc) {
          L.push('- ' + t.holder + '：把 **' + t.bank + '** 的 ' + my(t.excess) + ' 转出 → ' + rc.label + '（' + (rc.kind === 'new' ? '新开机构' : '名下未满') + '）' + my(rc.amount));
        });
      });
    });
    if (!r.plan.perHolder.length) L.push('- 无需转出');
    L.push('');
    L.push('## 五、提示');
    L.push('');
    r.flags.forEach(function (f) { L.push('- ' + f.text.replace(/\*\*/g, '')); });
    L.push('');
    L.push('## 六、限额敏感性');
    L.push('');
    L.push('| 限额 | 存款类覆盖率 | 全口径覆盖率 | 敞口 | 最大单点敞口 | 最少机构数 |');
    L.push('|---|---|---|---|---|---|');
    r.sensitivity.forEach(function (s) {
      L.push('| ' + m0(s.limit) + (s.current ? '（当前）' : '') + ' | ' + pc(s.covD) + ' | ' + pc(s.covT) + ' | ' + my(s.excess) + ' | ' + my(s.emax) + ' | ' + s.needs.map(function (n) { return n.holder + ' ' + n.needBanks + ' 家'; }).join('，') + ' |');
    });
    L.push('');
    L.push('## 七、算法与边界');
    L.push('');
    L.push('- 同一「持有人 + 机构」的多笔合并成一组；受保 = min(本息合计, 限额)。');
    L.push('- 只有存款类产品计入；银行理财 / 基金 / 保险不在这套保障口径内。');
    L.push('- 额度按人算，不同持有人的剩余额度不能互相占用。');
    L.push('- 金额用整数「分」计算，不走浮点小数。');
    L.push('- 不联网、不查机构名录、不评价机构安全性、不给投资建议；判定分组只是显示分组。');
    return L.join('\n');
  }

  // ── 结果卡 PNG ──────────────────────────────────────────────
  function tokenize(s) {
    var out = [], re = /(¥?[\d][\d,]*(?:\.\d+)?%?)/g, last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) Array.prototype.push.apply(out, s.slice(last, m.index).split(''));
      out.push(m[1]);
      last = m.index + m[1].length;
    }
    if (last < s.length) Array.prototype.push.apply(out, s.slice(last).split(''));
    return out;
  }
  var PUNCT = /[，。；：！？、）】」』%,.;:!?)\]}》]/;
  function wrapText(ctx, text, maxWidth, maxLines) {
    var toks = tokenize(String(text)), lines = [], cur = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (cur && ctx.measureText(cur + t).width > maxWidth) { lines.push(cur); cur = t; }
      else cur += t;
    }
    if (cur) lines.push(cur);
    for (var j = 1; j < lines.length; j++) {
      var guard = 0;
      while (lines[j].length && PUNCT.test(lines[j][0]) && lines[j - 1].length && guard++ < 40) {
        lines[j] = lines[j - 1].slice(-1) + lines[j];
        lines[j - 1] = lines[j - 1].slice(0, -1);
      }
    }
    if (maxLines && lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var lastL = lines[maxLines - 1];
      while (lastL.length && ctx.measureText(lastL + '…').width > maxWidth) lastL = lastL.slice(0, -1);
      lines[maxLines - 1] = lastL + '…';
    }
    return lines;
  }
  function cardLines(r) {
    var T = r.totals, pts = [];
    pts.push('存款类 ' + my(T.deposit) + '，其中 ' + my(T.covered) + ' 在限额之内，' + my(T.excess) + ' 在保障之外');
    if (T.excess > 0) pts.push('最大单点敞口：' + T.emaxHolder + ' @ ' + T.emaxBank + ' ' + my(T.emax));
    else pts.push('按当前限额，没有敞口');
    var gaps = r.holders.filter(function (h) { return h.gapBanks > 0; });
    if (gaps.length) pts.push('还需新开 ' + r.plan.totalNewBanks + ' 家机构：' + gaps.map(function (h) { return h.holder + ' 差 ' + h.gapBanks + ' 家'; }).join('，'));
    else if (T.excess > 0) pts.push('机构数够，但钱没摊开，把超出的部分挪到未满的机构即可');
    else pts.push('机构数已经装得下');
    return pts;
  }
  function drawCard(r) {
    var cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    var g = cv.getContext('2d'), T = r.totals;
    var F = function (w, s) { return w + ' ' + s + 'px system-ui,"PingFang SC",sans-serif'; };
    g.fillStyle = '#f4f8fd'; g.fillRect(0, 0, 1080, 1350);
    g.fillStyle = '#ffffff'; g.fillRect(48, 48, 984, 1254);
    g.strokeStyle = '#d9e3ee'; g.lineWidth = 2; g.strokeRect(48, 48, 984, 1254);
    g.fillStyle = '#4f6b91'; g.font = F(600, 24);
    g.fillText('DEPOSIT COVER · 存款保障对账台', 96, 132);
    g.fillStyle = '#22344e'; g.font = F(700, 52);
    var tl = wrapText(g, '有多少钱在这套保障之内', 840, 1);
    g.fillText(tl[0], 96, 208);
    g.strokeStyle = '#e4eaf1'; g.beginPath(); g.moveTo(96, 244); g.lineTo(984, 244); g.stroke();

    // 主数字：受保金额 / 存款类合计
    g.fillStyle = '#5a6d84'; g.font = F(600, 26);
    g.fillText('受保金额 / 存款类合计', 96, 306);
    var big = my(T.covered), size = 76;
    g.font = F(750, size);
    while (g.measureText(big).width > 560 && size > 40) { size -= 4; g.font = F(750, size); }
    g.fillStyle = T.excess > 0 ? '#a23b28' : '#2b6b4f';
    g.fillText(big, 96, 386);
    var bw = g.measureText(big).width;
    g.fillStyle = '#5a6d84'; g.font = F(600, 34);
    g.fillText('/ ' + my(T.deposit), 96 + bw + 16, 386);

    // 三格
    var boxes = [
      ['存款类覆盖率', pc(T.covD)],
      ['全口径覆盖率', pc(T.covT)],
      ['保障外敞口', my(T.excess)]
    ];
    boxes.forEach(function (b, i) {
      var x = 96 + i * 300;
      g.fillStyle = '#f7fafe'; g.fillRect(x, 430, 276, 150);
      g.strokeStyle = '#d9e3ee'; g.strokeRect(x, 430, 276, 150);
      g.fillStyle = '#6a7c92'; g.font = F(600, 24);
      g.fillText(b[0], x + 22, 478);
      g.fillStyle = i === 2 && T.excess > 0 ? '#a23b28' : '#22344e';
      g.font = F(700, 46);
      g.fillText(b[1], x + 22, 542);
    });

    // 逐组
    g.fillStyle = '#22344e'; g.font = F(700, 32);
    g.fillText('逐组（同一机构已合并）', 96, 654);
    g.font = F(400, 27);
    var y = 704;
    r.groups.slice(0, 6).forEach(function (gr) {
      g.fillStyle = '#3d4f66';
      var left = gr.holder + ' @ ' + gr.bank + '：' + my(gr.total);
      var lines = wrapText(g, left, 700, 1);
      g.fillText(lines[0], 96, y);
      g.fillStyle = gr.excess > 0 ? '#a23b28' : '#2b6b4f';
      g.textAlign = 'right';
      g.fillText(gr.excess > 0 ? '敞口 ' + my(gr.excess) : '全额在内', 984, y);
      g.textAlign = 'left';
      y += 44;
    });

    // 要点：紧跟逐组列表，并按剩余高度裁剪，既不压到页脚也不留大片空白
    g.font = F(400, 27);
    var pts = cardLines(r), blocks = [], need = 50;
    var layout = function () {
      blocks = []; need = 50;
      pts.forEach(function (p) {
        var b = wrapText(g, '· ' + p, 860, 2);
        blocks.push(b); need += b.length * 40 + 8;
      });
    };
    layout();
    var start = y + 34;
    while (blocks.length > 1 && start + need > 1230) { pts.pop(); layout(); }
    y = start;
    g.fillStyle = '#22344e'; g.font = F(700, 32);
    g.fillText('要点', 96, y); y += 50;
    g.font = F(400, 27);
    blocks.forEach(function (b) {
      g.fillStyle = '#3d4f66';
      b.forEach(function (ln) { g.fillText(ln, 96, y); y += 40; });
      y += 8;
    });

    g.fillStyle = '#7b8ca0'; g.font = F(400, 23);
    g.fillText('虚构示例口径；限额与金额由用户填写，页面不联网、不评价任何机构安全性。', 96, 1252);
    return cv;
  }
  function exportPNG(r) {
    var cv = drawCard(r);
    if (cv.toBlob) {
      cv.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'deposit-cover-card-1080x1350.png';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        $('message').textContent = '已下载结果卡 PNG。';
      }, 'image/png');
    } else {
      var a2 = document.createElement('a');
      a2.href = cv.toDataURL('image/png');
      a2.download = 'deposit-cover-card-1080x1350.png';
      document.body.appendChild(a2); a2.click();
      setTimeout(function () { a2.remove(); }, 1500);
    }
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    // 立刻 remove() 会让 Chrome 取消这次下载；延迟清理（实测踩过）
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  // ── 持久化 ──────────────────────────────────────────────────
  function payload(extra) {
    var p = { app: APP, limit: model.limit, rows: model.rows, ts: new Date().toISOString() };
    if (extra) Object.assign(p, extra);
    return p;
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(payload()));
      $('message').textContent = '已保存到本机浏览器（限额与 ' + model.rows.length + ' 行输入）。';
    } catch (e) { $('message').textContent = '保存失败：' + e.message; }
  }
  function restore(silent) {
    var raw = null;
    try { raw = localStorage.getItem(STORE); } catch (e) { raw = null; }
    if (!raw) { if (!silent) $('message').textContent = '本机没有已保存的输入。'; return false; }
    try {
      var d = JSON.parse(raw);
      if (!d || d.app !== APP || !Array.isArray(d.rows)) { if (!silent) $('message').textContent = '已保存的内容不是本应用的备份。'; return false; }
      writeInput(d); recompute(true);
      if (!silent) $('message').textContent = '已读取本机保存的输入（' + new Date(d.ts).toLocaleString() + '）。';
      return true;
    } catch (e) { if (!silent) $('message').textContent = '读取失败：' + e.message; return false; }
  }

  // ── 错误处理与重算 ──────────────────────────────────────────
  function showError(msgs) {
    $('error').innerHTML = msgs.map(function (m) { return '<div>· ' + esc(m) + '</div>'; }).join('');
    $('resultBody').innerHTML = '';
    $('downloads').style.display = 'none';
    lastResult = null;
  }
  function clearError() { $('error').innerHTML = ''; $('downloads').style.display = ''; }

  function recompute(silent) {
    if (!silent) $('message').textContent = '';
    readInput();
    var n = C.normalize(model);
    if (!n.ok) { showError(n.errors); return; }
    clearError();
    lastResult = C.analyze(n.cfg);
    renderResult(lastResult);
  }

  function applyPlanRows() {
    if (!lastResult) return;
    if (!lastResult.plan.applicable) { $('message').textContent = '当前方案不能一键采用（原因见结果区）。'; return; }
    undoRows = model.rows.map(function (r) { return Object.assign({}, r); });
    undoLimit = model.limit;
    var rows = C.applyPlan(lastResult.input, lastResult);
    writeInput({ limit: model.limit, rows: rows });
    recompute(true);
    $('message').textContent = '已按参考方案改写输入（同一机构的多笔合并成一行，组金额不变），可以点「还原上一版」回到原样。';
  }

  function bindResult() {
    var ap = $('applyPlan');
    if (ap) ap.addEventListener('click', applyPlanRows);
    var up = $('undoPlan');
    if (up) up.addEventListener('click', function () {
      if (!undoRows) return;
      writeInput({ limit: undoLimit || model.limit, rows: undoRows });
      undoRows = null; undoLimit = null;
      recompute(true);
      $('message').textContent = '已还原到你上一版的输入。';
    });
  }

  // ── 事件绑定 ────────────────────────────────────────────────
  function bind() {
    $('rows').addEventListener('input', function () { recompute(true); });
    $('rows').addEventListener('change', function () { recompute(true); });
    $('limit').addEventListener('input', function () { recompute(true); });
    $('recompute').addEventListener('click', function () { recompute(); $('message').textContent = '已按当前输入重算。'; });
    $('demo').addEventListener('click', function () { writeInput(C.defaults); recompute(); $('message').textContent = '已载入虚构示例。'; });
    $('addRow').addEventListener('click', function () {
      readInput();
      if (model.rows.length >= C.LIMITS.MAX_ROWS) { $('message').textContent = '最多 ' + C.LIMITS.MAX_ROWS + ' 行。'; return; }
      model.rows.push({ holder: model.rows.length ? model.rows[0].holder : '本人', bank: '', type: '定期存款', principal: '', interest: '' });
      renderRows(); recompute(true);
    });
    $('rows').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!b) return;
      var i = Number(b.getAttribute('data-i'));
      readInput();
      if (b.getAttribute('data-act') === 'del') {
        if (model.rows.length <= C.LIMITS.MIN_ROWS) { $('message').textContent = '至少要留 1 行。'; return; }
        model.rows.splice(i, 1);
      } else {
        if (model.rows.length >= C.LIMITS.MAX_ROWS) { $('message').textContent = '最多 ' + C.LIMITS.MAX_ROWS + ' 行。'; return; }
        model.rows.splice(i + 1, 0, Object.assign({}, model.rows[i]));
      }
      renderRows(); recompute(true);
    });
    $('presets').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-scene]') : null;
      if (!b) return;
      var s = SCENES[Number(b.getAttribute('data-scene'))];
      writeInput(s); recompute();
      $('message').textContent = '已载入场景：' + s.name + '（虚构示例）。';
    });
    $('csv').addEventListener('click', function () { if (lastResult) { download('deposit-cover-detail.csv', csvText(lastResult), 'text/csv;charset=utf-8'); $('message').textContent = '已下载 CSV 明细。'; } });
    $('md').addEventListener('click', function () { if (lastResult) { download('deposit-cover-result.md', mdText(lastResult), 'text/markdown;charset=utf-8'); $('message').textContent = '已下载结果说明 MD。'; } });
    $('json').addEventListener('click', function () { if (lastResult) { download('deposit-cover-backup.json', JSON.stringify(payload(), null, 2), 'application/json'); $('message').textContent = '已下载 JSON 备份。'; } });
    $('png').addEventListener('click', function () { if (lastResult) exportPNG(lastResult); });
    $('save').addEventListener('click', save);
    $('restore').addEventListener('click', function () { restore(false); });
    $('backup').addEventListener('click', function () {
      download('deposit-cover-backup.json', JSON.stringify(payload(), null, 2), 'application/json');
      $('message').textContent = '已下载备份（限额 + 输入行）。';
    });
    $('import').addEventListener('click', function () { $('imports').click(); });
    $('imports').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var d = JSON.parse(String(fr.result));
          if (!d || d.app !== APP || !Array.isArray(d.rows)) throw new Error('不是本应用的备份文件');
          writeInput(d); recompute(true);
          $('message').textContent = '已从备份导入（限额 + ' + d.rows.length + ' 行）。';
        } catch (e) { $('message').textContent = '导入失败：' + e.message; }
        ev.target.value = '';
      };
      fr.readAsText(f);
    });
  }

  function init() {
    renderPresets();
    writeInput(C.defaults);
    $('modelHint').innerHTML = modelText();
    bind();
    recompute(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__depositCover = {
    get result() { return lastResult; },
    get model() { return model; },
    recompute: recompute, writeInput: writeInput, applyPlanRows: applyPlanRows,
    csvText: csvText, mdText: mdText, drawCard: drawCard,
    SCENES: SCENES
  };
})();
