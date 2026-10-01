/* 页面交互：录入 -> 调用领域模型复核 -> 渲染结论。
 * 任何输入变化立即作废旧结论，绝不保留过期结果。 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var resultEl = $('result');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var EXAMPLES = {
    ok: {
      nameL: 'air', nameR: 'ground',
      baseline: [
        'S1: 通电前外部检查',
        'S2: 惯导初始对准',
        'S3: 发动机地面试车',
        'S4: 低速滑行',
        'S5: 起飞离地'
      ].join('\n'),
      opsL: [
        'a1 replace S2: 惯导初始对准（双支确认）',
        'a2 delete S3',
        'a3 insert NA after S3: 左支替代试车检查',
        'a4 insert LA after HEAD: 机载电源自检'
      ].join('\n'),
      opsR: [
        'g1 replace S2: 惯导初始对准（双支确认）',
        'g2 delete S3',
        'g3 insert NB after S3: 右支替代试车检查'
      ].join('\n')
    },
    conflict: {
      nameL: 'air', nameR: 'ground',
      baseline: [
        'S1: 通电前外部检查',
        'S2: 惯导初始对准',
        'S3: 发动机地面试车',
        'S4: 低速滑行',
        'S5: 起飞离地'
      ].join('\n'),
      opsL: [
        'a1 delete S4',
        'a2 replace S2: 快速对准'
      ].join('\n'),
      opsR: [
        'g1 insert RB after S2: 右支补充放油检查',
        'g2 replace S2: 精对准',
        'g3 replace S4: 高速滑行'
      ].join('\n')
    }
  };

  function loadExample(ex) {
    $('nameL').value = ex.nameL;
    $('nameR').value = ex.nameR;
    $('baseline').value = ex.baseline;
    $('opsL').value = ex.opsL;
    $('opsR').value = ex.opsR;
    invalidate();
  }

  // ---- 作废旧结论：输入变化或校验失败都调用，结果区回到占位/错误，不留旧表 ----
  function invalidate(showHint) {
    resultEl.innerHTML =
      '<div class="placeholder" id="resultPlaceholder">② 复核结论将显示在这里——' +
      '通过时给出规范合并步骤表与每条操作的保留 / 转换 / 合并结果；' +
      '冲突时给出首个冲突的双方操作及变换依据。</div>';
    $('staleHint').hidden = !showHint;
  }

  function describeOpObject(op) {
    if (!op) return '（对方步骤已不存在 / 基线实体）';
    var lines = [];
    lines.push('操作标识: ' + op.id);
    if (op.branch) lines.push('所属分支: ' + op.branch);
    lines.push('类型: ' + ({ insert: '插入', delete: '删除', replace: '替换' }[op.type] || op.type || '—'));
    if (op.type === 'insert') {
      lines.push('新步骤标识: ' + op.stepId);
      lines.push('锚点: ' + (op.anchor === null || op.anchor === undefined ? 'HEAD（首位）' : op.anchor));
      lines.push('文本: ' + op.text);
    } else if (op.type === 'delete') {
      lines.push('目标步骤: ' + op.target);
    } else if (op.type === 'replace') {
      lines.push('目标步骤: ' + op.target);
      lines.push('新文本: ' + op.text);
    }
    if (op.missingStepId) lines.push('缺失的步骤标识: ' + op.missingStepId);
    return lines.join('\n');
  }

  function originTag(row, branchNames) {
    if (row.origin === 'baseline') return '<span class="tag baseline">基线</span>';
    var idx = branchNames.indexOf(row.origin);
    return '<span class="tag branch branch-' + (idx === 1 ? 'b' : 'a') +
      '">支：' + esc(row.origin) + '</span>';
  }

  function renderOk(r) {
    var h = [];
    h.push('<div class="banner ok">✔ 复核通过：两支修订可以合为一份可执行步骤表（共 ' +
      r.table.length + ' 条执行步骤，' + r.tombstones.length + ' 个墓碑仅用于锚定）。</div>');

    h.push('<div class="block-title">规范合并步骤表（执行序列，标识稳定寻址）</div>');
    h.push('<table><thead><tr><th class="num">#</th><th>步骤标识</th><th>步骤文本</th><th>来源</th></tr></thead><tbody>');
    r.table.forEach(function (row, i) {
      var tags = originTag(row, r.branchNames);
      if (row.replaced) tags += '<span class="tag replaced">文本经替换</span>';
      h.push('<tr><td class="num">' + (i + 1) + '</td><td class="step-id">' + esc(row.id) +
        '</td><td>' + esc(row.text) + '</td><td><div class="tags">' + tags + '</div></td></tr>');
    });
    h.push('</tbody></table>');

    if (r.tombstones.length) {
      h.push('<div class="block-title">保留的删除锚点（墓碑，不执行、不摘除）</div>');
      h.push('<ul class="tomb-list">');
      r.tombstones.forEach(function (t) {
        h.push('<li><span class="step-id">' + esc(t.id) + '</span>（' +
          (t.origin === 'baseline' ? '基线步骤' : '支「' + esc(t.origin) + '」插入') +
          '）由 <span class="step-id">' + esc(t.deletedBy.branch) + '/' + esc(t.deletedBy.opId) +
          '</span> 删除，仍可作为插入锚点。</li>');
      });
      h.push('</ul>');
    }

    h.push('<div class="block-title">每条原操作的变换结果</div>');
    h.push('<table><thead><tr><th>分支</th><th>操作</th><th>类型</th><th>内容</th>' +
      '<th>裁定</th><th>变换依据</th></tr></thead><tbody>');
    var fateLabel = { retained: '保留', transformed: '转换', merged: '合并' };
    r.opResults.forEach(function (op) {
      var withRef = op.with
        ? '<span class="with-ref">关联：' + esc(op.with.branch) + '/' + esc(op.with.opId) + '</span>'
        : '';
      var bidx = r.branchNames.indexOf(op.branch) === 1 ? 'b' : 'a';
      h.push('<tr>' +
        '<td><span class="tag branch branch-' + bidx + '">' + esc(op.branch) + '</span></td>' +
        '<td class="step-id">' + esc(op.opId) + '</td>' +
        '<td class="op-type">' + esc(({ insert: '插入', delete: '删除', replace: '替换' })[op.type]) + '</td>' +
        '<td>' + esc(op.detail) + '</td>' +
        '<td><span class="fate ' + op.fate + '">' + fateLabel[op.fate] + '</span></td>' +
        '<td class="basis">' + esc(op.basis) + withRef + '</td>' +
      '</tr>');
    });
    h.push('</tbody></table>');

    resultEl.innerHTML = h.join('');
  }

  function renderError(e) {
    var h = [];
    h.push('<div class="banner bad">✘ 复核未通过：' + esc(e.message) + '</div>');

    // 录入/解析类错误没有“双方操作”，直接列出全部解析问题。
    if (e.code === 'malformed' && !e.op) {
      h.push('<div class="conflict-card"><div class="cc-head">录入问题（按出现处列出）</div>');
      h.push('<div class="cc-basis">' + esc(e.basis || e.message).replace(/\n/g, '<br>') + '</div></div>');
      resultEl.innerHTML = h.join('');
      return;
    }

    h.push('<div class="conflict-card">');
    h.push('<div class="cc-head">首个冲突（按操作处理顺序裁定；拒绝整次合并，防止修改落错步骤）</div>');
    h.push('<div class="conflict-cols">');
    h.push('<div class="conflict-op"><h4>本方操作（触发拒绝）</h4><pre>' +
      esc(describeOpObject(e.op)) + '</pre></div>');
    h.push('<div class="conflict-op"><h4>对方操作 / 冲突实体</h4><pre>' +
      esc(describeOpObject(e.otherOp)) + '</pre></div>');
    h.push('</div>');
    h.push('<div class="cc-basis"><b>变换依据：</b>' + esc(e.basis) + '</div>');
    h.push('</div>');
    resultEl.innerHTML = h.join('');
  }

  function runMerge() {
    var nameL = $('nameL').value.trim();
    var nameR = $('nameR').value.trim();
    var r = window.ChecklistOT.mergeFromText(
      nameL,
      $('baseline').value,
      nameL, $('opsL').value,
      nameR, $('opsR').value
    );
    $('staleHint').hidden = true;
    if (r.ok) renderOk(r);
    else renderError(r.error); // 校验/冲突失败：渲染错误并覆盖任何旧结论
  }

  // 事件绑定
  ['baseline', 'opsL', 'opsR', 'nameL', 'nameR'].forEach(function (id) {
    $(id).addEventListener('input', function () { invalidate(true); });
  });
  $('btnMerge').addEventListener('click', runMerge);
  $('btnExampleOk').addEventListener('click', function () { loadExample(EXAMPLES.ok); });
  $('btnExampleConflict').addEventListener('click', function () { loadExample(EXAMPLES.conflict); });
  $('btnClear').addEventListener('click', function () {
    ['baseline', 'opsL', 'opsR'].forEach(function (id) { $(id).value = ''; });
    invalidate(false);
  });

  loadExample(EXAMPLES.ok);
  runMerge(); // 初始即展示一次复核结论；之后输入任意变化立即作废
})();
