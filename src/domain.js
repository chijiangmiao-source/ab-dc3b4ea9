/*
 * 飞行试验检查单 · 双支离线修订操作变换（OT）领域模型
 *
 * 关键设计：
 *  - 序列模型保留墓碑（tombstone）：删除只打标记，锚点仍可定位，避免位置漂移。
 *  - 插入以“锚点 + (分支名, 操作标识)”定序：同锚点并发插入按该键稳定裁定。
 *  - 删除/替换以步骤的全局唯一 ASCII 标识定位，与下标无关。
 *  - 重复删除、相同替换合并；不同替换、删除×替换交叉、重复新标识、悬空引用拒绝。
 *
 * 本文件为 UMD：浏览器挂到 window.ChecklistOT，Node 下可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChecklistOT = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_OPS_PER_BRANCH = 80;
  var ID_RE = /^[A-Za-z0-9_.@-]+$/;
  var HEAD = null;

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function fail(code, message, op, otherOp, basis) {
    return {
      ok: false,
      error: {
        code: code,
        message: message,
        op: op || null,
        otherOp: otherOp || null,
        basis: basis || ''
      }
    };
  }

  function isNonEmptyString(x) {
    return typeof x === 'string' && x.trim().length > 0;
  }

  function withBranch(branchName, op) {
    var copy = {};
    for (var k in op) {
      if (Object.prototype.hasOwnProperty.call(op, k)) copy[k] = op[k];
    }
    copy.branch = branchName;
    return copy;
  }

  // 并发插入裁定键：(分支名, 操作标识) 的 UTF-16 码元字典序。
  function keyCmp(a, b) {
    if (a.branch < b.branch) return -1;
    if (a.branch > b.branch) return 1;
    if (a.opId < b.opId) return -1;
    if (a.opId > b.opId) return 1;
    return 0;
  }

  function anchorLabel(anchor) {
    return anchor === HEAD ? '首位' : anchor;
  }

  // 对操作的一句话人类可读描述（供逐条裁定表使用）。
  function describeOp(op) {
    if (op.type === 'insert') {
      return '插入新步骤 ' + op.stepId + '，锚于 ' + anchorLabel(op.anchor) +
        '，文本「' + op.text + '」';
    }
    if (op.type === 'delete') {
      return '删除步骤 ' + op.target;
    }
    return '替换步骤 ' + op.target + ' 文本为「' + op.text + '」';
  }

  // ---------------------------------------------------------------------------
  // 结构化校验
  // ---------------------------------------------------------------------------

  function validateShape(input) {
    if (!input || typeof input !== 'object') {
      return fail('malformed', '输入为空或不是对象。');
    }
    if (!Array.isArray(input.baseline)) {
      return fail('malformed', '缺少基线步骤数组 baseline。');
    }
    if (!Array.isArray(input.branches) || input.branches.length !== 2) {
      return fail('malformed', '必须提供恰好两支离线分支。');
    }

    var baseline = [];
    var baseIds = Object.create(null);
    for (var i = 0; i < input.baseline.length; i++) {
      var s = input.baseline[i];
      if (!s || !isNonEmptyString(s.id) || !isNonEmptyString(s.text)) {
        return fail('malformed', '基线第 ' + (i + 1) + ' 条缺少标识或文本。');
      }
      var id = s.id.trim();
      if (!ID_RE.test(id)) {
        return fail('malformed', '基线步骤标识「' + id + '」不是合法 ASCII 标识（允许 A-Za-z0-9_.@-）。');
      }
      if (baseIds[id]) {
        return fail('duplicate-baseline-id', '基线步骤标识重复：' + id + '。');
      }
      baseIds[id] = true;
      baseline.push({ id: id, text: s.text.trim() });
    }

    var names = [];
    for (var b = 0; b < 2; b++) {
      var br = input.branches[b];
      if (!br || !isNonEmptyString(br.name)) {
        return fail('malformed', '第 ' + (b + 1) + ' 支分支缺少名称。');
      }
      var name = br.name.trim();
      if (names.indexOf(name) >= 0) {
        return fail('malformed', '两支分支名称相同：「' + name + '」，无法稳定裁定。');
      }
      names.push(name);
      if (!Array.isArray(br.ops)) {
        return fail('malformed', '分支「' + name + '」缺少操作数组。');
      }
      if (br.ops.length > MAX_OPS_PER_BRANCH) {
        return fail('too-many-ops',
          '分支「' + name + '」有 ' + br.ops.length + ' 条操作，超过每支至多 ' +
          MAX_OPS_PER_BRANCH + ' 条的限制。');
      }
      var opIds = Object.create(null);
      for (var j = 0; j < br.ops.length; j++) {
        var op = br.ops[j];
        var where = '分支「' + name + '」第 ' + (j + 1) + ' 条操作';
        if (!op || !isNonEmptyString(op.id)) {
          return fail('malformed', where + ' 缺少操作标识。');
        }
        if (!ID_RE.test(op.id.trim())) {
          return fail('malformed', where + ' 的操作标识「' + op.id + '」不是合法 ASCII 标识。');
        }
        op.id = op.id.trim();
        if (opIds[op.id]) {
          return fail('duplicate-op-id',
            '分支「' + name + '」操作标识重复：' + op.id + '。');
        }
        opIds[op.id] = true;

        if (op.type === 'insert') {
          if (!isNonEmptyString(op.stepId) || !ID_RE.test(op.stepId.trim())) {
            return fail('malformed', where + '（' + op.id + '）缺少合法的新步骤标识 stepId。');
          }
          op.stepId = op.stepId.trim();
          if (op.anchor !== null && op.anchor !== HEAD &&
              (!isNonEmptyString(op.anchor) || !ID_RE.test(op.anchor.trim()))) {
            return fail('malformed', where + '（' + op.id + '）锚点必须为 HEAD/首位或合法步骤标识。');
          }
          if (op.anchor !== null && op.anchor !== HEAD) op.anchor = op.anchor.trim();
          if (!isNonEmptyString(op.text)) {
            return fail('malformed', where + '（' + op.id + '）插入步骤缺少文本。');
          }
          op.text = op.text.trim();
        } else if (op.type === 'delete') {
          if (!isNonEmptyString(op.target) || !ID_RE.test(op.target.trim())) {
            return fail('malformed', where + '（' + op.id + '）缺少合法目标标识 target。');
          }
          op.target = op.target.trim();
        } else if (op.type === 'replace') {
          if (!isNonEmptyString(op.target) || !ID_RE.test(op.target.trim())) {
            return fail('malformed', where + '（' + op.id + '）缺少合法目标标识 target。');
          }
          op.target = op.target.trim();
          if (!isNonEmptyString(op.text)) {
            return fail('malformed', where + '（' + op.id + '）替换文本为空。');
          }
          op.text = op.text.trim();
        } else {
          return fail('malformed', where + '（' + op.id + '）类型非法：' + op.type + '。');
        }
      }
    }

    return { ok: true, baseline: baseline, branches: input.branches };
  }

  // ---------------------------------------------------------------------------
  // 合并主体
  // ---------------------------------------------------------------------------

  function mergeChecklist(rawInput) {
    var v = validateShape(rawInput);
    if (!v.ok) return v;
    var baseline = v.baseline;
    var left = v.branches[0];
    var right = v.branches[1];

    // 节点表：基线节点与插入节点，含墓碑（alive=false 不摘除）。
    var nodes = new Map();
    // 锚点孩子表：parentId(null=首位虚锚) -> 按裁定键排序的插入节点 id。
    var kids = new Map();
    kids.set(HEAD, []);
    // stepId -> 出生键（分支名, 操作标识）
    var born = new Map();
    // 目标步骤 -> 替换流水（按归并处理顺序）
    var replog = new Map();
    // 每条操作的裁定结论：按分支/操作标识两级寻址
    var fates = new Map();

    function getFate(branch, opId) {
      var byOp = fates.get(branch);
      return byOp ? byOp.get(opId) : undefined;
    }
    function setFate(branch, opId, fate, basis, withRef) {
      var byOp = fates.get(branch);
      if (!byOp) { byOp = new Map(); fates.set(branch, byOp); }
      byOp.set(opId, { fate: fate, basis: basis || '', with: withRef || null });
    }

    baseline.forEach(function (s, idx) {
      nodes.set(s.id, {
        id: s.id, text: s.text, alive: true,
        origin: 'baseline', anchor: HEAD, baseIndex: idx,
        deletedBy: null
      });
    });

    function placeInsert(nodeId, anchor) {
      var key = born.get(nodeId);
      var arr = kids.get(anchor);
      if (!arr) { arr = []; kids.set(anchor, arr); }
      var pos = 0;
      while (pos < arr.length && keyCmp(born.get(arr[pos]), key) <= 0) pos++;
      arr.splice(pos, 0, nodeId);
    }

    function logReplace(target, entry) {
      var log = replog.get(target);
      if (!log) { log = []; replog.set(target, log); }
      log.push(entry);
    }

    // 归并一支。left 先应用（other 为 null）；right 随后做跨支检查与变换。
    function applyBranch(branch, otherName) {
      for (var i = 0; i < branch.ops.length; i++) {
        var op = withBranch(branch.name, branch.ops[i]);
        var bop = op;

        if (op.type === 'insert') {
          if (nodes.has(op.stepId)) {
            var first = born.get(op.stepId);
            var firstOp = first ? withBranch(first.branch, findOp(first.branch, first.opId)) : null;
            var whereDup = first
              ? '与 ' + first.branch + ' 支 ' + first.opId + ' 创建的步骤重名'
              : '与基线步骤重名';
            return fail('duplicate-step-id',
              '插入步骤的新标识 ' + op.stepId + ' 重复（' + whereDup + '），必须全局唯一。',
              bop, firstOp,
              '两支离线修订都可能创建步骤，新步骤标识若与基线或对方插入重复，' +
              '合流后无法区分实体；按处理顺序首个重复点即此，拒绝合并。');
          }
          if (op.anchor !== HEAD) {
            if (!nodes.has(op.anchor)) {
              return fail('dangling-reference',
                '操作 ' + op.id + ' 的锚点 ' + op.anchor + ' 在本支应用时不存在。',
                bop, { missingStepId: op.anchor },
                '插入位置以锚点标识定位；锚点在基线与本支先前插入中都不可见，' +
              '若按序号猜测会把修改落到错误步骤，故拒绝。');
            }
            var anc = nodes.get(op.anchor);
            if (anc.origin !== 'baseline' && anc.origin !== branch.name) {
              return fail('dangling-reference',
                '操作 ' + op.id + ' 的锚点 ' + op.anchor + ' 仅存在于对方分支的插入中，本支不可见。',
                bop, withBranch(anc.origin, findOp(anc.origin, born.get(anc.id).opId)),
                '离线时本支从未收到对方插入的 ' + op.anchor + '，该引用属于悬空引用，拒绝以防位置漂移。');
            }
          }
          nodes.set(op.stepId, {
            id: op.stepId, text: op.text, alive: true,
            origin: branch.name, anchor: op.anchor,
            baseIndex: -1, deletedBy: null
          });
          born.set(op.stepId, { branch: branch.name, opId: op.id });
          placeInsert(op.stepId, op.anchor);
          // 默认结论先记“保留”，并发同锚点/墓碑等在收尾阶段细化为“转换”。
          setFate(branch.name, op.id, 'retained', '按锚点原样保留定位。');
        }

        else if (op.type === 'delete') {
          if (!nodes.has(op.target) ||
              (nodes.get(op.target).origin !== 'baseline' &&
               nodes.get(op.target).origin !== branch.name)) {
            var origin = nodes.has(op.target) ? nodes.get(op.target).origin : null;
            var other = null;
            if (origin && born.has(op.target)) {
              var bb = born.get(op.target);
              other = withBranch(bb.branch, findOp(bb.branch, bb.opId));
            }
            return fail('dangling-reference',
              '操作 ' + op.id + ' 要删除的 ' + op.target + ' 在本支不可见（不存在或为对方私有插入）。',
              bop, other || { missingStepId: op.target },
              '删除以稳定标识寻址；目标在本支视图中不存在时按序号落刀会误删，拒绝。');
          }
          var n = nodes.get(op.target);
          if (!n.alive) {
            setFate(branch.name, op.id, 'merged',
              '步骤 ' + op.target + ' 已是墓碑（由 ' + n.deletedBy.branch +
              ' 支 ' + n.deletedBy.opId + ' 删除），重复删除并入该墓碑，不产生第二次效果。',
              refObj(n.deletedBy));
          } else {
            // 跨支：对方已替换文本而本支删除 -> 删除与替换交叉。
            if (otherName !== null) {
              var otherLog = (replog.get(op.target) || []).filter(function (e) {
                return e.branch === otherName;
              });
              if (otherLog.length > 0) {
                var lastOther = otherLog[otherLog.length - 1];
                return fail('delete-replace-cross',
                  '步骤 ' + op.target + ' 上删除与替换交叉。',
                  bop, withBranch(otherName, findOp(otherName, lastOther.opId)),
                  '对方分支把 ' + op.target + ' 的文本替换为「' + lastOther.text +
                  '」，本支却删除该步骤；以稳定标识定位可见两修改作用于同一实体，' +
                  '删除与替换意图不可调和，按处理顺序首个交叉点即此，拒绝合并。');
              }
            }
            n.alive = false;
            n.deletedBy = { branch: branch.name, opId: op.id };
            setFate(branch.name, op.id, 'retained',
              '以标识 ' + op.target + ' 定位并删除，序列中保留墓碑作为后续锚点。');
          }
        }

        else { // replace
          if (!nodes.has(op.target) ||
              (nodes.get(op.target).origin !== 'baseline' &&
               nodes.get(op.target).origin !== branch.name)) {
            var rorigin = nodes.has(op.target) ? nodes.get(op.target).origin : null;
            var rother = null;
            if (rorigin && born.has(op.target)) {
              var rb = born.get(op.target);
              rother = withBranch(rb.branch, findOp(rb.branch, rb.opId));
            }
            return fail('dangling-reference',
              '操作 ' + op.id + ' 要替换的 ' + op.target + ' 在本支不可见（不存在或为对方私有插入）。',
              bop, rother || { missingStepId: op.target },
              '替换以稳定标识寻址；目标在本支视图中不存在，拒绝以避免替换落到错误步骤。');
          }
          var rn = nodes.get(op.target);
          if (!rn.alive) {
            return fail('delete-replace-cross',
              '步骤 ' + op.target + ' 上删除与替换交叉。',
              bop, withBranch(rn.deletedBy.branch, findOp(rn.deletedBy.branch, rn.deletedBy.opId)),
              '操作 ' + op.id + ' 试图替换已被 ' + rn.deletedBy.branch + ' 支 ' +
              rn.deletedBy.opId + ' 删除的步骤 ' + op.target +
              '；墓碑只用于锚定位置，不能被替换，删除与替换交叉，拒绝。');
          }
          if (otherName !== null) {
            var xlog = (replog.get(op.target) || []).filter(function (e) {
              return e.branch === otherName;
            });
            if (xlog.length > 0) {
              var lo = xlog[xlog.length - 1];
              if (lo.text === op.text) {
                logReplace(op.target, {
                  branch: branch.name, opId: op.id, text: op.text, mergedCross: true
                });
                setFate(branch.name, op.id, 'merged',
                  '与 ' + otherName + ' 支 ' + lo.opId + ' 对 ' + op.target +
                  ' 的替换文本完全相同，相同替换合并为一次。',
                  refObj({ branch: otherName, opId: lo.opId }));
                continue;
              }
              return fail('different-replacement',
                '步骤 ' + op.target + ' 上出现不同的并发替换。',
                bop, withBranch(otherName, findOp(otherName, lo.opId)),
                '本支替换文本为「' + op.text + '」，' + otherName + ' 支替换文本为「' + lo.text +
                '」；两者以同一稳定标识 ' + op.target + ' 定位，确认是并发分歧而非位置漂移，' +
                '文本不同无法自动吸收，按处理顺序首个冲突点即此，拒绝合并。');
            }
          }
          logReplace(op.target, { branch: branch.name, opId: op.id, text: op.text });
          rn.text = op.text;
          setFate(branch.name, op.id, 'retained',
            '以标识 ' + op.target + ' 定位替换，不受其他步骤增删的下标影响。');
        }
      }
      return null;
    }

    function findOp(branchName, opId) {
      var bs = branchName === left.name ? left : right;
      for (var i = 0; i < bs.ops.length; i++) {
        if (bs.ops[i].id === opId) return bs.ops[i];
      }
      return { id: opId };
    }

    function refObj(r) { return { branch: r.branch, opId: r.opId }; }

    var err = applyBranch(left, null);
    if (err) return err;
    err = applyBranch(right, left.name);
    if (err) return err;

    // -------------------------------------------------------------------------
    // 收尾：逐条操作结论细化
    // -------------------------------------------------------------------------

    // 1) 同锚点并发插入 -> 转换（列出裁定键定序依据）。
    kids.forEach(function (arr, parent) {
      if (arr.length <= 1) return;
      var origins = {};
      arr.forEach(function (cid) { origins[nodes.get(cid).origin] = true; });
      var mixed = Object.keys(origins).length > 1;
      if (!mixed) return;
      var orderDesc = arr.map(function (cid, idx) {
        var k = born.get(cid);
        return '第' + (idx + 1) + '位=' + cid + '（键 ' + k.branch + '/' + k.opId + '）';
      }).join('，');
      arr.forEach(function (cid) {
        var k = born.get(cid);
        var n = nodes.get(cid);
        var extra = '';
        if (parent !== HEAD && !nodes.get(parent).alive) {
          var d = nodes.get(parent).deletedBy;
          extra = ' 锚点 ' + parent + ' 已被 ' + d.branch + ' 支 ' + d.opId +
            ' 删除，墓碑保留，新步骤仍紧随该墓碑定位。';
        }
        var deadNote = n.alive ? '' : ' 该插入步骤后又被同支删除，不进入执行表。';
        setFate(k.branch, k.opId, 'transformed',
          '与他支在同一锚点（' + anchorLabel(parent) + '）并发插入，位置经操作变换：按 (分支名, 操作标识) ' +
          '字典序裁定，' + orderDesc + '。' + extra + deadNote);
      });
    });

    // 2) 锚点为墓碑（他支所删）的单独插入 -> 保留，但写明墓碑依据。
    kids.forEach(function (arr, parent) {
      if (parent === HEAD) return;
      var pn = nodes.get(parent);
      if (pn.alive) return;
      arr.forEach(function (cid) {
        var k = born.get(cid);
        var f = getFate(k.branch, k.opId);
        if (f && f.fate === 'retained') {
          setFate(k.branch, k.opId, 'retained',
            '锚点 ' + parent + ' 已被 ' + pn.deletedBy.branch + ' 支 ' + pn.deletedBy.opId +
            ' 删除；因序列保留墓碑，' + cid + ' 仍准确定位在该墓碑之后，原样保留。');
        }
      });
    });

    // 3) 插入后被同支删除的插入操作 -> 转换说明。
    nodes.forEach(function (n) {
      if (n.origin === 'baseline') return;
      if (n.alive) return;
      var k = born.get(n.id);
      var f = getFate(k.branch, k.opId);
      if (f && f.fate === 'retained') {
        setFate(k.branch, k.opId, 'transformed',
          '插入的 ' + n.id + ' 随后被同支 ' + n.deletedBy.opId +
          ' 删除，仅以墓碑留在序列中供锚定，不进入执行表。');
      }
    });

    // 4) 替换流水：同支顺序覆盖、相同替换合并、被同支后续删除移除。
    replog.forEach(function (log, target) {
      var node = nodes.get(target);
      var perBranch = {};
      log.forEach(function (e) {
        (perBranch[e.branch] = perBranch[e.branch] || []).push(e);
      });
      Object.keys(perBranch).forEach(function (bn) {
        var entries = perBranch[bn];
        var last = entries[entries.length - 1];
        for (var i = 0; i < entries.length - 1; i++) {
          var e = entries[i];
          if (e.mergedCross) continue; // 已在应用时记为合并
          if (e.text === last.text) {
            setFate(bn, e.opId, 'merged',
              '与同支后续 ' + last.opId + ' 对 ' + target + ' 的替换文本相同，相同替换合并。',
              refObj({ branch: bn, opId: last.opId }));
          } else {
            setFate(bn, e.opId, 'transformed',
              '同支按顺序再次替换 ' + target + '（' + last.opId +
              '），本替换被顺序覆盖，以末值「' + last.text + '」为准。',
              refObj({ branch: bn, opId: last.opId }));
          }
        }
        if (!last.mergedCross && !node.alive && node.deletedBy.branch === bn) {
          setFate(bn, last.opId, 'transformed',
            '替换的 ' + target + ' 随后被同支 ' + node.deletedBy.opId +
            ' 删除，替换随步骤一并移除，不进入执行表。',
            refObj(node.deletedBy));
        }
      });
    });

    // -------------------------------------------------------------------------
    // 输出
    // -------------------------------------------------------------------------

    function walk(id, out) {
      var n = nodes.get(id);
      out.push(n);
      (kids.get(id) || []).forEach(function (c) { walk(c, out); });
    }

    var full = [];
    kids.get(HEAD).forEach(function (cid) { walk(cid, full); });
    baseline.forEach(function (s) { walk(s.id, full); });

    var table = [];
    var tombstones = [];
    full.forEach(function (n) {
      if (n.alive) {
        table.push({
          id: n.id,
          text: n.text,
          origin: n.origin,
          anchor: n.origin === 'baseline' ? null : n.anchor,
          replaced: replog.has(n.id)
        });
      } else {
        tombstones.push({
          id: n.id,
          origin: n.origin,
          deletedBy: n.deletedBy
        });
      }
    });

    var opResults = [];
    [left, right].forEach(function (branch) {
      branch.ops.forEach(function (op) {
        var f = getFate(branch.name, op.id) ||
          { fate: 'retained', basis: '', with: null };
        opResults.push({
          branch: branch.name,
          opId: op.id,
          type: op.type,
          detail: describeOp(withBranch(branch.name, op)),
          fate: f.fate,
          basis: f.basis,
          with: f.with
        });
      });
    });

    return {
      ok: true,
      branchNames: [left.name, right.name],
      table: table,
      tombstones: tombstones,
      opResults: opResults
    };
  }

  // ---------------------------------------------------------------------------
  // 行式录入解析（页面与文档示例共用）
  //   基线：  ID: 文本
  //   插入：  OPID insert STEPID after ANCHOR: 文本   （ANCHOR 可用 HEAD/首位）
  //   删除：  OPID delete TARGET
  //   替换：  OPID replace TARGET: 新文本
  // ---------------------------------------------------------------------------

  function splitLine(line) {
    return line.trim();
  }

  function parseBaselineText(text) {
    var steps = [];
    var errors = [];
    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var line = splitLine(raw);
      if (!line) return;
      var m = line.match(/^([^:：]+)[:：](.*)$/);
      if (!m) {
        errors.push({ line: i + 1, message: '应为「标识: 文本」格式。' });
        return;
      }
      var id = m[1].trim();
      var body = m[2].trim();
      if (!body) errors.push({ line: i + 1, message: '步骤「' + id + '」文本为空。' });
      steps.push({ id: id, text: body });
    });
    return { steps: steps, errors: errors };
  }

  function parseOpsText(text) {
    var ops = [];
    var errors = [];
    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var line = splitLine(raw);
      if (!line) return;
      var m;
      if ((m = line.match(
        /^(\S+)\s+(?:insert|ins|插入)\s+(\S+)\s+(?:after|aft|锚于)\s+(\S+)\s*[:：]\s*(.*)$/i
      ))) {
        var anchor = m[3];
        if (/^(HEAD|FIRST|首位)$/i.test(anchor)) anchor = null;
        ops.push({ id: m[1], type: 'insert', stepId: m[2], anchor: anchor, text: m[4].trim() });
      } else if ((m = line.match(/^(\S+)\s+(?:delete|del|删除)\s+(\S+)\s*$/i))) {
        ops.push({ id: m[1], type: 'delete', target: m[2] });
      } else if ((m = line.match(/^(\S+)\s+(?:replace|rep|替换)\s+(\S+)\s*[:：]\s*(.*)$/i))) {
        ops.push({ id: m[1], type: 'replace', target: m[2], text: m[3].trim() });
      } else {
        errors.push({ line: i + 1, message: '无法识别的操作（支持 insert/delete/replace）。' });
      }
    });
    return { ops: ops, errors: errors };
  }

  function mergeFromText(branchAName, baseText, nameL, opsLText, nameR, opsRText) {
    var base = parseBaselineText(baseText);
    var opsL = parseOpsText(opsLText);
    var opsR = parseOpsText(opsRText);
    var errors = []
      .concat(base.errors.map(function (e) { return '基线第 ' + e.line + ' 行：' + e.message; }))
      .concat(opsL.errors.map(function (e) { return '左支第 ' + e.line + ' 行：' + e.message; }))
      .concat(opsR.errors.map(function (e) { return '右支第 ' + e.line + ' 行：' + e.message; }));
    if (errors.length) {
      return fail('malformed', errors[0], null, null, errors.join('\n'));
    }
    return mergeChecklist({
      baseline: base.steps,
      branches: [
        { name: nameL, ops: opsL.ops },
        { name: nameR, ops: opsR.ops }
      ]
    });
  }

  return {
    MAX_OPS_PER_BRANCH: MAX_OPS_PER_BRANCH,
    mergeChecklist: mergeChecklist,
    parseBaselineText: parseBaselineText,
    parseOpsText: parseOpsText,
    mergeFromText: mergeFromText,
    describeOp: describeOp
  };
});
