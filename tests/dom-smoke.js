/*
 * app.js 页面接线冒烟（无浏览器环境下的极简 DOM 桩）。
 * 验证：初始自动出结论、冲突渲染双方操作与依据、输入变更立即作废旧结论。
 * 运行：node tests/dom-smoke.js
 */
'use strict';
var assert = require('assert');
var path = require('path');

function makeEl(id) {
  var listeners = {};
  return {
    id: id, value: '', hidden: false, innerHTML: '',
    addEventListener: function (type, fn) { listeners[type] = fn; },
    _fire: function (type) { listeners[type] && listeners[type](); }
  };
}
var els = {};
['baseline', 'opsL', 'opsR', 'nameL', 'nameR', 'staleHint', 'result',
 'btnMerge', 'btnExampleOk', 'btnExampleConflict', 'btnClear'
].forEach(function (id) { els[id] = makeEl(id); });

global.document = { getElementById: function (id) { return els[id]; } };
global.window = { ChecklistOT: require(path.join(__dirname, '..', 'src', 'domain.js')) };

require(path.join(__dirname, '..', 'src', 'app.js'));

var out = els.result.innerHTML;

// 1. 初始载入“可合并示例”并自动复核
assert.ok(/复核通过/.test(out), '应显示通过横幅');
assert.ok(/规范合并步骤表/.test(out), '应显示合并步骤表');
assert.ok(/NA/.test(out) && /NB/.test(out), '应含两支插入步骤');
assert.ok(/每条原操作的变换结果/.test(out), '应显示逐条操作结果');
assert.ok(/保留|转换|合并/.test(out), '应有三类裁定');
assert.ok(/墓碑/.test(out), '综合示例中 S3 被双删，应列墓碑');
console.log('  ✓ 初始自动复核：通过结论、步骤表、逐条结果、墓碑均渲染');

// 2. 输入变更 -> 旧结论立即作废
els.baseline.value = els.baseline.value + '\nS6: 多加一行';
els.baseline._fire('input');
assert.ok(!/<table>/.test(els.result.innerHTML), '变更后旧表必须消失');
assert.ok(/复核结论将显示在这里/.test(els.result.innerHTML), '应回到占位提示');
assert.strictEqual(els.staleHint.hidden, false, '应提示旧结论已作废');
console.log('  ✓ 输入变更即作废旧结论（不保留旧表，显示作废提示）');

// 3. 冲突示例 -> 首个冲突双方操作与变换依据
els.btnExampleConflict._fire('click');
assert.ok(!/<table>/.test(els.result.innerHTML), '载入新输入时旧结论须作废');
els.btnMerge._fire('click');
var bad = els.result.innerHTML;
assert.ok(/复核未通过/.test(bad), '应显示未通过横幅');
assert.ok(/首个冲突/.test(bad), '应标注首个冲突');
assert.ok(/g2/.test(bad) && /a2/.test(bad), '应展示冲突双方操作标识（g2 vs a2）');
assert.ok(/变换依据/.test(bad), '应给出变换依据');
assert.ok(/稳定标识/.test(bad.basis || bad), '依据应说明以稳定标识定位');
console.log('  ✓ 冲突拒绝：展示首个冲突双方操作（g2 / a2）及变换依据');

// 4. 回到可合并示例重新复核 -> 结论恢复
els.btnExampleOk._fire('click');
els.btnMerge._fire('click');
assert.ok(/复核通过/.test(els.result.innerHTML), '重新复核应恢复通过结论');
console.log('  ✓ 重新复核可恢复通过结论');

// 5. 清空 -> 占位、无旧结论
els.btnClear._fire('click');
assert.ok(!/<table>|banner ok/.test(els.result.innerHTML), '清空后不得残留结论');
console.log('  ✓ 清空后不残留任何旧结论');

console.log('\n页面接线冒烟全部通过。');
