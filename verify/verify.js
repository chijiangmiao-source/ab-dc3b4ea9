/*
 * Compose verify 服务入口：领域测试 + 构建检查 + 页面/健康 HTTP 冒烟。
 * 全部通过退出码 0；任一项失败立即非零退出，由 Compose 报告验收结果。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var failed = false;

function step(title) {
  process.stdout.write('\n=== ' + title + ' ===\n');
}
function ok(msg) { process.stdout.write('  PASS  ' + msg + '\n'); }
function bad(msg) {
  failed = true;
  process.stdout.write('  FAIL  ' + msg + '\n');
}
function run(cmd, args, opts) {
  var r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// 1. 领域测试（须覆盖：同锚点并发插入、墓碑后插入、冲突拒绝）
// ---------------------------------------------------------------------------
step('1/3 领域测试');

var t0 = Date.now();
var t = run('node', [path.join(ROOT, 'tests', 'domain.test.js')]);
process.stdout.write(t.out);
if (t.code === 0) ok('领域测试退出码 0（' + (Date.now() - t0) + 'ms）');
else bad('领域测试失败，退出码 ' + t.code);

var d0 = Date.now();
var ds = run('node', [path.join(ROOT, 'tests', 'dom-smoke.js')]);
process.stdout.write(ds.out);
if (ds.code === 0) ok('页面接线冒烟退出码 0（' + (Date.now() - d0) + 'ms）');
else bad('页面接线冒烟失败，退出码 ' + ds.code);

var testSrc = fs.readFileSync(path.join(ROOT, 'tests', 'domain.test.js'), 'utf8');
[
  ['同锚点并发插入', /同锚点.*并发插入/],
  ['墓碑后插入', /墓碑后插入/],
  ['冲突拒绝', /delete-replace-cross|different-replacement|dangling-reference|duplicate-step-id/]
].forEach(function (pair) {
  if (pair[1].test(testSrc)) ok('验收覆盖面：' + pair[0]);
  else bad('领域测试缺少覆盖场景：' + pair[0]);
});

// ---------------------------------------------------------------------------
// 2. 构建检查：JS 语法 + 页面资源引用完整 + 页面与领域模型同源一致
// ---------------------------------------------------------------------------
step('2/3 构建检查');

['src/domain.js', 'src/app.js', 'tests/domain.test.js', 'tests/dom-smoke.js', 'verify/verify.js'].forEach(function (rel) {
  var r = run('node', ['--check', path.join(ROOT, rel)]);
  if (r.code === 0) ok('语法检查 ' + rel);
  else bad('语法错误 ' + rel + '\n' + r.out);
});

var html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
['domain.js', 'app.js', 'styles.css'].forEach(function (asset) {
  var referenced = html.indexOf(asset) >= 0;
  var exists = fs.existsSync(path.join(ROOT, 'src', asset));
  if (referenced && exists) ok('页面资源存在且被引用：' + asset);
  else bad('页面资源缺失或未引用：' + asset);
});

var domainSrc = fs.readFileSync(path.join(ROOT, 'src', 'domain.js'), 'utf8');
[
  ['墓碑（alive/deletedBy）', /alive\s*=\s*false[\s\S]*deletedBy|deletedBy[\s\S]*alive/],
  ['(分支名,操作标识) 稳定裁定', /keyCmp|分支名.*操作标识/],
  ['保留/转换/合并 三类裁定', /retained/],
  ['每支至多 80 条', /MAX_OPS_PER_BRANCH\s*=\s*80/]
].forEach(function (pair) {
  if (pair[1].test(domainSrc)) ok('领域模型要点：' + pair[0]);
  else bad('领域模型缺少要点：' + pair[0]);
});

// 领域模型在“测试路径 /app/src”与“页面路径 /usr/share/nginx/html”必须是同一份内容。
var webRoot = process.env.WEB_ROOT || '/usr/share/nginx/html';
if (fs.existsSync(path.join(webRoot, 'domain.js'))) {
  var a = fs.readFileSync(path.join(ROOT, 'src', 'domain.js'), 'utf8');
  var b = fs.readFileSync(path.join(webRoot, 'domain.js'), 'utf8');
  if (a === b) ok('页面引用的 domain.js 与测试所用文件内容一致');
  else bad('页面 domain.js 与仓库 src/domain.js 不一致（镜像构建过期？）');
}

// ---------------------------------------------------------------------------
// 3. HTTP 冒烟：页面 + 健康响应（经 Compose 网络访问 web 服务）
// ---------------------------------------------------------------------------
step('3/3 页面 / 健康 HTTP 冒烟');

var HOST = process.env.WEB_HOST || 'web';
var PORT = process.env.WEB_PORT || '80';
var base = 'http://' + HOST + ':' + PORT;

function httpGet(url) {
  var r = run('wget', ['-qO-', '--timeout=5', url], { maxBuffer: 8 * 1024 * 1024 });
  return r.code === 0 ? r.out : null;
}
function waitFor(url, tries) {
  for (var i = 0; i < tries; i++) {
    var body = httpGet(url);
    if (body !== null) return body;
    run('sleep', ['1']);
  }
  return null;
}

var health = waitFor(base + '/health', 30);
if (health !== null) {
  ok('GET /health -> 200');
  try {
    var j = JSON.parse(health);
    if (j.status === 'ok') ok('健康 JSON status=ok');
    else bad('健康 JSON 内容异常：' + health);
  } catch (e) { bad('健康响应不是合法 JSON：' + health); }
} else {
  bad('GET /health 在 30 次重试后仍失败：' + base + '/health');
}

var page = httpGet(base + '/');
if (page !== null) {
  ok('GET / -> 200');
  if (/双支离线修订复核/.test(page)) ok('页面标题存在');
  else bad('页面缺少预期标题');
  if (/domain\.js/.test(page) && /app\.js/.test(page)) ok('页面引用前端脚本');
  else bad('页面缺少脚本引用');
} else {
  bad('GET / 失败：' + base + '/');
}

var domainAsset = httpGet(base + '/domain.js');
if (domainAsset !== null && /mergeChecklist/.test(domainAsset)) {
  ok('GET /domain.js -> 200 且包含合并入口');
} else {
  bad('GET /domain.js 失败或内容异常');
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
step('验收汇总');
if (failed) {
  process.stdout.write('VERIFY RESULT: FAIL\n');
  process.exit(1);
}
process.stdout.write('VERIFY RESULT: PASS（领域测试、构建检查、HTTP 冒烟全部通过）\n');
process.exit(0);
