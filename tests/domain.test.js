/*
 * 领域测试：双支离线修订操作变换
 * 零依赖，Node 直接运行：node tests/domain.test.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var OT = require(path.join(__dirname, '..', 'src', 'domain.js'));
var merge = OT.mergeChecklist;

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  process.stdout.write('  ✓ ' + name + '\n');
}
function ok(r) { assert.ok(r.ok, 'expected ok but: ' + JSON.stringify(r.error)); return r; }
function err(r, code) {
  assert.ok(!r.ok, 'expected error ' + code + ' but merge succeeded');
  assert.strictEqual(r.error.code, code,
    'expected code ' + code + ' got ' + r.error.code + ' / ' + r.error.message);
  return r.error;
}
function ids(r) { return r.table.map(function (s) { return s.id; }); }
function texts(r) { return r.table.map(function (s) { return s.text; }); }
function fate(r, branch, opId) {
  var f = r.opResults.filter(function (x) {
    return x.branch === branch && x.opId === opId;
  })[0];
  assert.ok(f, 'no fate for ' + branch + '/' + opId);
  return f;
}
var base = [
  { id: 'S1', text: '通电前检查' },
  { id: 'S2', text: '惯导对准' },
  { id: 'S3', text: '发动机试车' },
  { id: 'S4', text: '滑行' },
  { id: 'S5', text: '起飞' }
];
function input(lops, rops, ln, rn) {
  return {
    baseline: base.map(function (s) { return { id: s.id, text: s.text }; }),
    branches: [
      { name: ln || 'alpha', ops: lops },
      { name: rn || 'bravo', ops: rops }
    ]
  };
}

console.log('一、结构校验');

test('空基线、两支空操作 -> 通过，结果等于基线', function () {
  var r = ok(merge(input([], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.deepStrictEqual(texts(r), texts({ table: base }));
});

test('基线标识重复 -> duplicate-baseline-id', function () {
  var r = merge({
    baseline: [{ id: 'X1', text: 'a' }, { id: 'X1', text: 'b' }],
    branches: [{ name: 'a', ops: [] }, { name: 'b', ops: [] }]
  });
  err(r, 'duplicate-baseline-id');
});

test('支内操作标识重复 -> duplicate-op-id', function () {
  var r = merge(input(
    [{ id: 'o1', type: 'delete', target: 'S1' },
     { id: 'o1', type: 'delete', target: 'S2' }], []));
  err(r, 'duplicate-op-id');
});

test('分支重名 -> malformed', function () {
  var r = merge({
    baseline: base,
    branches: [{ name: 'a', ops: [] }, { name: 'a', ops: [] }]
  });
  err(r, 'malformed');
});

test('每支超过 80 条 -> too-many-ops', function () {
  var ops = [];
  for (var i = 0; i < 81; i++) {
    ops.push({ id: 'p' + i, type: 'replace', target: 'S1', text: 'v' + i });
  }
  err(merge(input(ops, [])), 'too-many-ops');
});

test('恰好 80 条 -> 通过', function () {
  var ops = [];
  for (var i = 0; i < 80; i++) {
    ops.push({ id: 'p' + i, type: 'insert', stepId: 'N' + i, anchor: 'S5', text: 'n' + i });
  }
  var r = ok(merge(input(ops, [])));
  assert.strictEqual(r.table.length, 85);
});

test('非 ASCII 标识 -> malformed', function () {
  err(merge(input([{ id: 'o1', type: 'delete', target: '步骤1' }], [])), 'malformed');
  err(merge({
    baseline: [{ id: 'S 1', text: 'x' }],
    branches: [{ name: 'a', ops: [] }, { name: 'b', ops: [] }]
  }), 'malformed');
});

console.log('二、插入：首位 / 锚点 / 墓碑后插入');

test('锚点首位(anchor=null)插入排在最前，基线仍按原序', function () {
  var r = ok(merge(input(
    [{ id: 'L1', type: 'insert', stepId: 'LA', anchor: null, text: '首检' }], [])));
  assert.deepStrictEqual(ids(r), ['LA', 'S1', 'S2', 'S3', 'S4', 'S5']);
});

test('锚定尚存步骤之后插入', function () {
  var r = ok(merge(input(
    [{ id: 'L1', type: 'insert', stepId: 'LA', anchor: 'S2', text: 'S2 后补充' }], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'LA', 'S3', 'S4', 'S5']);
});

test('可锚定本支先前插入的步骤（插入链）', function () {
  var r = ok(merge(input([
    { id: 'L1', type: 'insert', stepId: 'A1', anchor: 'S1', text: 'a1' },
    { id: 'L2', type: 'insert', stepId: 'A2', anchor: 'A1', text: 'a2' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'A1', 'A2', 'S2', 'S3', 'S4', 'S5']);
});

test('删除后锚定墓碑插入：新步骤仍在原位置，删除步骤不进执行表', function () {
  var r = ok(merge(input([
    { id: 'D2', type: 'delete', target: 'S2' },
    { id: 'L1', type: 'insert', stepId: 'A1', anchor: 'S2', text: '替代惯导对准' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'A1', 'S3', 'S4', 'S5']);
  assert.deepStrictEqual(r.tombstones.map(function (t) { return t.id; }), ['S2']);
  assert.ok(/墓碑/.test(fate(r, 'alpha', 'L1').basis));
});

test('左支删除 S2，右支在 S2 墓碑后插入 -> 位置不漂移', function () {
  var r = ok(merge(input(
    [{ id: 'D2', type: 'delete', target: 'S2' }],
    [{ id: 'R1', type: 'insert', stepId: 'B1', anchor: 'S2', text: '右支补充' }])));
  assert.deepStrictEqual(ids(r), ['S1', 'B1', 'S3', 'S4', 'S5']);
  assert.ok(/墓碑/.test(fate(r, 'bravo', 'R1').basis));
});

test('多层插入锚定已删除的本支插入步骤', function () {
  var r = ok(merge(input([
    { id: 'I1', type: 'insert', stepId: 'A1', anchor: 'S2', text: 'a1' },
    { id: 'I2', type: 'insert', stepId: 'A2', anchor: 'A1', text: 'a2' },
    { id: 'D1', type: 'delete', target: 'A1' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'A2', 'S3', 'S4', 'S5']);
});

console.log('三、同锚点并发插入：按 (分支名, 操作标识) 稳定裁定');

test('同锚点 S2 并发插入 -> 字典序 (branch,opId) 定序', function () {
  var r = ok(merge(input(
    [{ id: 'z9', type: 'insert', stepId: 'AZ', anchor: 'S2', text: 'z' }],
    [{ id: 'a1', type: 'insert', stepId: 'BA', anchor: 'S2', text: 'a' }])));
  // alpha < bravo：alpha 的 AZ 在前（opId 顺序不跨支比较，先比分支名）
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'AZ', 'BA', 'S3', 'S4', 'S5']);
  assert.strictEqual(fate(r, 'alpha', 'z9').fate, 'transformed');
  assert.strictEqual(fate(r, 'bravo', 'a1').fate, 'transformed');
  assert.ok(/字典序/.test(fate(r, 'bravo', 'a1').basis));
});

test('同分支名场景由 opId 定序：改名使 zeta<beta 分支仍一致', function () {
  var r = ok(merge({
    baseline: base,
    branches: [
      { name: 'zeta', ops: [{ id: 'i9', type: 'insert', stepId: 'Z1', anchor: null, text: 'z' }] },
      { name: 'beta', ops: [{ id: 'i1', type: 'insert', stepId: 'B1', anchor: null, text: 'b' }] }
    ]
  }));
  // beta < zeta
  assert.deepStrictEqual(ids(r).slice(0, 2), ['B1', 'Z1']);
});

test('同锚点三个并发插入的总序', function () {
  var r = ok(merge({
    baseline: base,
    branches: [
      { name: 'a', ops: [
        { id: 'm', type: 'insert', stepId: 'AM', anchor: 'S5', text: 'm' },
        { id: 'q', type: 'insert', stepId: 'AQ', anchor: 'S5', text: 'q' }
      ] },
      { name: 'b', ops: [
        { id: 'a', type: 'insert', stepId: 'BA', anchor: 'S5', text: 'a' }
      ] }
    ]
  }));
  // a 支全部排在 b 支前；a 支内按 opId m<q
  assert.deepStrictEqual(ids(r).slice(5), ['AM', 'AQ', 'BA']);
});

test('裁定结果对输入顺序不敏感（左右交换同结果）', function () {
  var mk = function (ln, rn) {
    return merge({
      baseline: base,
      branches: [
        { name: ln, ops: [{ id: 'o', type: 'insert', stepId: ln[0].toUpperCase(), anchor: 'S1', text: ln }] },
        { name: rn, ops: [{ id: 'o', type: 'insert', stepId: rn[0].toUpperCase(), anchor: 'S1', text: rn }] }
      ]
    });
  };
  var r1 = ok(mk('alpha', 'bravo'));
  var r2 = ok(mk('bravo', 'alpha'));
  assert.deepStrictEqual(ids(r1), ids(r2));
  assert.deepStrictEqual(ids(r1), ['S1', 'A', 'B', 'S2', 'S3', 'S4', 'S5']);
});

console.log('四、删除');

test('双支删除同一步骤 -> 重复删除合并为一个墓碑', function () {
  var r = ok(merge(input(
    [{ id: 'd1', type: 'delete', target: 'S3' }],
    [{ id: 'd2', type: 'delete', target: 'S3' }])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'S4', 'S5']);
  assert.strictEqual(r.tombstones.length, 1);
  assert.strictEqual(fate(r, 'alpha', 'd1').fate, 'retained');
  assert.strictEqual(fate(r, 'bravo', 'd2').fate, 'merged');
  assert.ok(/重复删除/.test(fate(r, 'bravo', 'd2').basis));
});

test('同支重复删除 -> 合并', function () {
  var r = ok(merge(input([
    { id: 'd1', type: 'delete', target: 'S3' },
    { id: 'd2', type: 'delete', target: 'S3' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'S4', 'S5']);
  assert.strictEqual(fate(r, 'alpha', 'd2').fate, 'merged');
});

console.log('五、替换');

test('不同步骤的替换互不影响，不依赖下标', function () {
  var r = ok(merge(input(
    [{ id: 'p1', type: 'replace', target: 'S2', text: '惯导对准（修订）' }],
    [{ id: 'q1', type: 'delete', target: 'S1' }])));
  assert.deepStrictEqual(ids(r), ['S2', 'S3', 'S4', 'S5']);
  assert.strictEqual(r.table[0].text, '惯导对准（修订）');
  assert.strictEqual(r.table[0].replaced, true);
});

test('双支相同替换 -> 合并', function () {
  var r = ok(merge(input(
    [{ id: 'p1', type: 'replace', target: 'S2', text: '同一新文本' }],
    [{ id: 'q1', type: 'replace', target: 'S2', text: '同一新文本' }])));
  assert.strictEqual(r.table[1].text, '同一新文本');
  var fates = ['p1', 'q1'].map(function (id, i) {
    return fate(r, i === 0 ? 'alpha' : 'bravo', id).fate;
  });
  assert.ok(fates.indexOf('merged') >= 0 && fates.indexOf('retained') >= 0);
});

test('双支不同替换同一步骤 -> different-replacement，并给出双方操作', function () {
  var e = err(merge(input(
    [{ id: 'p1', type: 'replace', target: 'S2', text: '甲文本' }],
    [{ id: 'q1', type: 'replace', target: 'S2', text: '乙文本' }])),
    'different-replacement');
  assert.strictEqual(e.op.id, 'q1');
  assert.strictEqual(e.otherOp.id, 'p1');
  assert.ok(/稳定标识/.test(e.basis));
});

test('同支顺序多次不同替换 -> 末值生效，前者转换为顺序覆盖', function () {
  var r = ok(merge(input([
    { id: 'p1', type: 'replace', target: 'S2', text: 'v1' },
    { id: 'p2', type: 'replace', target: 'S2', text: 'v2' }
  ], [])));
  assert.strictEqual(r.table[1].text, 'v2');
  assert.strictEqual(fate(r, 'alpha', 'p1').fate, 'transformed');
  assert.ok(/顺序覆盖/.test(fate(r, 'alpha', 'p1').basis));
  assert.strictEqual(fate(r, 'alpha', 'p2').fate, 'retained');
});

test('同支相同文本重复替换 -> 合并', function () {
  var r = ok(merge(input([
    { id: 'p1', type: 'replace', target: 'S2', text: 'v' },
    { id: 'p2', type: 'replace', target: 'S2', text: 'v' }
  ], [])));
  assert.strictEqual(fate(r, 'alpha', 'p1').fate, 'merged');
});

console.log('六、删除 × 替换交叉');

test('左支删除、右支替换同一步骤 -> delete-replace-cross（首个冲突含双方）', function () {
  var e = err(merge(input(
    [{ id: 'd1', type: 'delete', target: 'S4' }],
    [{ id: 'r1', type: 'replace', target: 'S4', text: '新滑行' }])),
    'delete-replace-cross');
  assert.strictEqual(e.op.id, 'r1');
  assert.strictEqual(e.otherOp.id, 'd1');
  assert.ok(/替换/.test(e.basis) && /删除/.test(e.basis));
});

test('左支替换、右支删除 -> 同样拒绝（方向对称）', function () {
  err(merge(input(
    [{ id: 'r1', type: 'replace', target: 'S4', text: '新滑行' }],
    [{ id: 'd1', type: 'delete', target: 'S4' }])), 'delete-replace-cross');
});

test('先删后替换（同支）-> 拒绝替换墓碑', function () {
  err(merge(input([
    { id: 'd1', type: 'delete', target: 'S4' },
    { id: 'r1', type: 'replace', target: 'S4', text: 'x' }
  ], [])), 'delete-replace-cross');
});

console.log('七、重复新标识与悬空引用');

test('插入标识与基线重复 -> duplicate-step-id', function () {
  var e = err(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'S3', anchor: null, text: 'x' }], [])),
    'duplicate-step-id');
  assert.strictEqual(e.op.id, 'i1');
});

test('两支插入使用同一新标识 -> duplicate-step-id，给出对方操作', function () {
  var e = err(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: '左' }],
    [{ id: 'i2', type: 'insert', stepId: 'X1', anchor: 'S2', text: '右' }])),
    'duplicate-step-id');
  assert.strictEqual(e.op.id, 'i2');
  assert.strictEqual(e.otherOp.id, 'i1');
});

test('同支重复新标识 -> 拒绝', function () {
  err(merge(input([
    { id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: 'a' },
    { id: 'i2', type: 'insert', stepId: 'X1', anchor: 'S1', text: 'b' }
  ], [])), 'duplicate-step-id');
});

test('插入锚点不存在 -> dangling-reference', function () {
  var e = err(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S99', text: 'x' }], [])),
    'dangling-reference');
  assert.strictEqual(e.otherOp.missingStepId, 'S99');
});

test('删除不存在的步骤 -> dangling-reference', function () {
  err(merge(input(
    [{ id: 'd1', type: 'delete', target: 'S99' }], [])), 'dangling-reference');
});

test('替换不存在的步骤 -> dangling-reference', function () {
  err(merge(input(
    [{ id: 'r1', type: 'replace', target: 'S99', text: 'x' }], [])), 'dangling-reference');
});

test('引用对方私有插入步骤 -> dangling-reference', function () {
  var e = err(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: '左支私有' }],
    [{ id: 'd1', type: 'delete', target: 'X1' }])),
    'dangling-reference');
  assert.strictEqual(e.otherOp.id, 'i1');
});

test('右支锚定左支私有插入 -> dangling-reference', function () {
  err(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: '左' }],
    [{ id: 'i2', type: 'insert', stepId: 'Y1', anchor: 'X1', text: '右' }])),
    'dangling-reference');
});

test('前向引用本支稍后才插入的步骤 -> 悬空（操作必须按顺序发生）', function () {
  err(merge(input([
    { id: 'i1', type: 'insert', stepId: 'Y1', anchor: 'X1', text: '先引用' },
    { id: 'i2', type: 'insert', stepId: 'X1', anchor: 'S1', text: '后创建' }
  ], [])), 'dangling-reference');
});

console.log('八、综合场景');

test('综合：并发插入+双删合并+相同替换合并+跨支锚点', function () {
  var r = ok(merge({
    baseline: base,
    branches: [
      { name: 'air', ops: [
        { id: 'a1', type: 'replace', target: 'S2', text: '惯导对准（双支确认）' },
        { id: 'a2', type: 'delete', target: 'S3' },
        { id: 'a3', type: 'insert', stepId: 'NA', anchor: 'S3', text: '左支替代试车' }
      ] },
      { name: 'ground', ops: [
        { id: 'g1', type: 'replace', target: 'S2', text: '惯导对准（双支确认）' },
        { id: 'g2', type: 'delete', target: 'S3' },
        { id: 'g3', type: 'insert', stepId: 'NB', anchor: 'S3', text: '右支替代试车' }
      ] }
    ]
  }));
  // air < ground：NA 在 NB 前，两者都锚在 S3 墓碑后
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'NA', 'NB', 'S4', 'S5']);
  assert.strictEqual(r.table[1].text, '惯导对准（双支确认）');
  assert.strictEqual(fate(r, 'ground', 'g1').fate, 'merged');
  assert.strictEqual(fate(r, 'ground', 'g2').fate, 'merged');
  assert.strictEqual(fate(r, 'air', 'a3').fate, 'transformed');
  assert.strictEqual(fate(r, 'ground', 'g3').fate, 'transformed');
});

test('插入后同支删除：插入操作转换为墓碑，不进执行表', function () {
  var r = ok(merge(input([
    { id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: 'x' },
    { id: 'd1', type: 'delete', target: 'X1' },
    { id: 'i2', type: 'insert', stepId: 'X2', anchor: 'X1', text: 'y' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'X2', 'S2', 'S3', 'S4', 'S5']);
  assert.strictEqual(fate(r, 'alpha', 'i1').fate, 'transformed');
});

test('冲突时不产出 table，且 error 指明变换依据', function () {
  var r = merge(input(
    [{ id: 'd1', type: 'delete', target: 'S1' }],
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S1', text: 'ok' },
     { id: 'r1', type: 'replace', target: 'S1', text: '冲突' }]));
  assert.ok(!r.ok);
  assert.strictEqual(r.table, undefined);
  assert.ok(r.error.basis.length > 10);
});

test('操作结果逐条覆盖每一条原操作', function () {
  var lo = [
    { id: 'a1', type: 'insert', stepId: 'X1', anchor: 'S1', text: 'x' },
    { id: 'a2', type: 'delete', target: 'S2' }
  ];
  var ro = [
    { id: 'b1', type: 'replace', target: 'S5', text: '起飞确认' }
  ];
  var r = ok(merge(input(lo, ro)));
  assert.strictEqual(r.opResults.length, 3);
  r.opResults.forEach(function (x) {
    assert.ok(['retained', 'transformed', 'merged'].indexOf(x.fate) >= 0);
    assert.ok(x.basis.length > 0);
    assert.ok(x.detail.length > 0);
  });
});

test('同支先替换后删除 -> 同支顺序意图删除生效，替换转换移除', function () {
  var r = ok(merge(input([
    { id: 'r1', type: 'replace', target: 'S4', text: '新滑行' },
    { id: 'd1', type: 'delete', target: 'S4' }
  ], [])));
  assert.deepStrictEqual(ids(r), ['S1', 'S2', 'S3', 'S5']);
  assert.strictEqual(fate(r, 'alpha', 'r1').fate, 'transformed');
  assert.strictEqual(fate(r, 'alpha', 'd1').fate, 'retained');
});

test('左支在 S2 后插入、右支删除 S2 -> 插入经墓碑稳定定位不漂移', function () {
  var r = ok(merge(input(
    [{ id: 'i1', type: 'insert', stepId: 'X1', anchor: 'S2', text: '补充' }],
    [{ id: 'd1', type: 'delete', target: 'S2' }])));
  assert.deepStrictEqual(ids(r), ['S1', 'X1', 'S3', 'S4', 'S5']);
  assert.ok(/墓碑/.test(fate(r, 'alpha', 'i1').basis));
});

test('行式解析器：合法行解析为操作，非法行报错', function () {
  var b = OT.parseBaselineText('S1: 通电检查\nS2: 试车\n');
  assert.strictEqual(b.steps.length, 2);
  var o = OT.parseOpsText(
    'L1 insert N1 after S2: 新步骤\nL2 delete S1\nL3 replace S3: 新文本');
  assert.strictEqual(o.ops.length, 3);
  assert.deepStrictEqual(o.ops[0], { id: 'L1', type: 'insert', stepId: 'N1', anchor: 'S2', text: '新步骤' });
  assert.strictEqual(o.ops[2].type, 'replace');
  var bad = OT.parseOpsText('L1 frobnicate S1');
  assert.strictEqual(bad.errors.length, 1);
  var head = OT.parseOpsText('L1 insert N1 after HEAD: 首位');
  assert.strictEqual(head.ops[0].anchor, null);
});

test('行式端到端合并', function () {
  var r = ok(OT.mergeFromText('a', 'S1: 一\nS2: 二\n',
    'air', 'L1 insert N1 after S1: 左',
    'ground', 'G1 delete S1'));
  assert.deepStrictEqual(ids(r), ['N1', 'S2']);
});

console.log('\n全部通过：' + passed + ' 项领域测试。');
