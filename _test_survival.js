// 离线回归测试：只抽取纯逻辑，stub 掉 bot/网络，不启动任何服务
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, 'server.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(want)} / 实得 ${JSON.stringify(got)}`);
}
function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error(`切片失败: ${from} / ${to}`);
  return src.slice(a, b);
}

// ── 1. walkTo 到达判定 ─────────────────────────────────
function makeWalkTo(arriveX, arriveY, arriveZ) {
  const chunk = slice('async function walkTo', '// ── 背包与工具');
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setMovements() {},
      async goto() { bot.entity.position = { x: arriveX, y: arriveY, z: arriveZ }; },
      stop() {},
      setGoal() {},
    },
  };
  const stubRequire = () => ({
    Movements: class { constructor() {} },
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }); } } },
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fn = new Function('bot', 'require', 'wait', chunk + '\nreturn walkTo;');
  return fn(bot, stubRequire, wait);
}

// ── 2. roamAway 方位记忆 ───────────────────────────────
function makeRoam() {
  const chunk = slice('let roamPref', '// 往一个方向走远一点');
  const state = { goodies: false, walked: [], lastOpts: null };
  const bot = {
    version: '1.20.1',
    entity: { position: { x: 0, y: 64, z: 0, clone: () => ({ x: 0, y: 64, z: 0 }) } },
    findBlock: () => (state.goodies ? { name: 'oak_log' } : null),
    nearestEntity: () => null,
  };
  const stubRequire = () => ({
    blocksByName: { oak_log: { id: 17 }, stone: { id: 1 }, coal_ore: { id: 16 } },
  });
  const env = {
    bot,
    require: stubRequire,
    wait: async () => {},
    trace: () => {},
    walkTo: async (x, y, z, opts) => {
      state.walked.push([x, z]);
      state.lastOpts = opts;
      return '走到了';
    },
  };
  const names = Object.keys(env);
  const fn = new Function(...names, chunk +
    '\nreturn { roamAway, getPref: () => roamPref, setPref: (a) => { roamPref = { ang: a, misses: 0 }; } };');
  const api = fn(...names.map((n) => env[n]));
  return { ...api, state };
}

// ── 3. buildWall 备料阈值 ─────────────────────────────
function makeWall(counts, mineGain, blocked, prebuilt) {
  const chunk = slice('const WALL_MATS', '// 每挖一块都重新确认');
  const bag = { ...counts };
  const placed = [];
  const env = {
    inv: () => ({ ...bag }),
    trace: () => {},
    deed: () => {},
    require: () => ({ Vec3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } }),
    bot: {
      entity: { position: { x: 10.3, y: 64, z: -5.7 } },
      // prebuilt(dx, dy, dz) 为真表示那一格已经实心
      blockAt: (v) => {
        const dx = v.x - 10;
        const dz = v.z - (-6);
        const dy = v.y - 64;
        return prebuilt && prebuilt(dx, dy, dz) ? { name: 'cobblestone' } : { name: 'air' };
      },
    },
    putBlock: async (name, x, y, z) => {
      const dx = x - 10;
      const dz = z - (-6);
      if (blocked && blocked(dx, dz)) return false;
      if (!bag[name]) return false;
      bag[name]--;
      placed.push(`${dx},${dz}`);
      return true;
    },
    digShelter: async () => '往脚下掏了个坑蹲着',
    ensurePick: async () => true,
    mineBlock: async (name) => {
      const key = name === 'stone' ? 'cobblestone' : 'dirt';
      bag[key] = (bag[key] || 0) + mineGain;
      return '挖了';
    },
  };
  const names = Object.keys(env);
  const fn = new Function(...names, chunk + '\nreturn { buildWall };');
  return { buildWall: fn(...names.map((n) => env[n])).buildWall, bag, placed };
}

// ── 4. judgeStep 完成判定 ─────────────────────────────
function makeJudge() {
  const chunk = slice('function judgeStep', 'function advanceStep');
  const step = { do: 'shelter' };
  const env = {
    todayGoal: () => ({ steps: [step] }),
    stepState: { base: {} },
    inv: () => ({}),
    LOGS: ['oak_log'],
    DROP_OF: {},
  };
  const names = Object.keys(env);
  const fn = new Function(...names, chunk + '\nreturn judgeStep;');
  const judge = fn(...names.map((n) => env[n]));
  return (d, msg) => { step.do = d; return judge({ stepIndex: 0 }, msg); };
}

(async () => {
  console.log('\n=== 1. walkTo 严格 / 宽松两档 ===');
  check('水平 3.5 格 · 默认 → 没走到', (await makeWalkTo(0, 64, 3.5)(0, 64, 0, {})).slice(0, 3), '没走到');
  check('水平 3.5 格 · loose → 走到了', (await makeWalkTo(0, 64, 3.5)(0, 64, 0, { loose: true })).slice(0, 3), '走到了');
  check('水平 5.5 格 · 默认 → 没走到', (await makeWalkTo(0, 64, 5.5)(0, 64, 0, {})).slice(0, 3), '没走到');
  check('水平 5.5 格 · loose → 走到了', (await makeWalkTo(0, 64, 5.5)(0, 64, 0, { loose: true })).slice(0, 3), '走到了');
  check('水平 7.5 格 · loose → 没走到(6 格外仍失败)', (await makeWalkTo(0, 64, 7.5)(0, 64, 0, { loose: true })).slice(0, 3), '没走到');
  check('水平 2 格 / 垂直差 5.5 · 默认 → 没走到', (await makeWalkTo(0, 69.5, 2)(0, 64, 0, {})).slice(0, 3), '没走到');
  check('水平 2 格 / 垂直差 5.5 · loose → 走到了', (await makeWalkTo(0, 69.5, 2)(0, 64, 0, { loose: true })).slice(0, 3), '走到了');
  check('回家(不带 opts) 仍严格', (await makeWalkTo(0, 64, 3.5)(0, 64, 0)).slice(0, 3), '没走到');

  console.log('\n=== 2. roamAway 方位记忆 ===');
  {
    const r = makeRoam();
    let same = 0;
    for (let i = 0; i < 800; i++) {
      r.setPref(0);
      r.state.walked = [];
      await r.roamAway(30);
      if (r.state.walked[0][0] > 20) same++;
    }
    const rate = (same / 800) * 100;
    check(`有偏好时朝该方向走的比例 ${rate.toFixed(1)}%（65% 设定 + 随机方向撞进同扇区）`, rate > 60 && rate < 85, true);
    const optOk = r.state.lastOpts && r.state.lastOpts.loose === true;
    check('roamAway 调用 walkTo 时传了 loose:true', optOk, true);

    const r2 = makeRoam();
    r2.state.goodies = true;
    r2.setPref(0);
    await r2.roamAway(30);
    check('到达后扫到资源 → 记住该方位', r2.getPref().ang !== null, true);

    const r3 = makeRoam();
    r3.state.goodies = false;
    r3.setPref(1.0);
    let cleared = false;
    for (let i = 0; i < 20 && !cleared; i++) {
      await r3.roamAway(30);
      cleared = r3.getPref().ang === null;
    }
    check('顺着偏好连续两次扑空 → 清空偏好', cleared, true);
  }

  console.log('\n=== 3. buildWall 备料阈值 ===');
  {
    const a = makeWall({ cobblestone: 16 }, 0, null);
    const ma = await a.buildWall();
    check('16 块 → 围满一圈 16 格', [ma.indexOf('围了一圈墙') >= 0, a.placed.length], [true, 16]);

    // 2026-11-19 实测踩到的：墙已经在那儿了，重垒时要把已有的算进去
    const retry = makeWall({ cobblestone: 16 }, 0, null, (dx, dy, dz) => !(dx === 0 && dz === 0));
    const mr = await retry.buildWall();
    check('墙已存在 + 重垒 → 认已有 16 格，不再重复消耗', [mr.indexOf('围了一圈墙') >= 0, retry.placed.length, retry.bag.cobblestone], [true, 0, 16]);

    const b = makeWall({ cobblestone: 7, dirt: 5 }, 0, null);
    const mb = await b.buildWall();
    check('12 块 → 小隔间 8 格 + 「料不够，先围个小的」', [mb.indexOf('料不够，先围个小的') >= 0, b.placed.length], [true, 8]);
    check('12 块 → 混用两种料，剩 4 块土', Object.entries(b.bag).filter(([, v]) => v > 0), [['dirt', 4]]);

    const c = makeWall({}, 8, null);
    const mc = await c.buildWall();
    check('0 块但能挖 → 备料后围小的', [mc.indexOf('料不够，先围个小的') >= 0, c.placed.length], [true, 8]);

    const d = makeWall({ dirt: 3 }, 0, null);
    const md = await d.buildWall();
    check('3 块且挖不到 → 掏洞兜底', md.indexOf('掏了个坑') >= 0, true);

    const e = makeWall({ cobblestone: 16 }, 0, (dx, dz) => Math.abs(dx) === 1 && Math.abs(dz) === 1);
    const me = await e.buildWall();
    check('16 块但四个角被挡 → 报「没成：只放上 8/16」', [me.startsWith('没成：'), e.placed.length], [true, 8]);
  }

  console.log('\n=== 4. judgeStep 完成判定 ===');
  {
    const j = makeJudge();
    check('围了一圈墙 → 完成', j('shelter', '围了一圈墙（16 块），背后总算不是空的'), true);
    check('料不够先围个小的 → 完成', j('shelter', '料不够，先围个小的（8 块，只围了四个正面，墙角还漏风）'), true);
    check('没成：只放上 8/16 → 未完成', j('shelter', '没成：只放上 8/16 块，有几个位置被树或水挡住了'), false);
    check('挖洞兜底 → 完成', j('shelter', '墙只起了 3 块就放不上了，往脚下掏了个坑蹲着'), true);
    check('料没凑够但掏了洞 → 完成', j('shelter', '料没凑够（3/8 块），往脚下掏了个坑蹲着'), true);
    check('wall 步骤 + 没成 → 未完成', j('wall', '没成：只放上 12/16 块，有几个位置被树或水挡住了'), false);
    check('wall 步骤 + 围满 → 完成', j('wall', '围了一圈墙（16 块），背后总算不是空的'), true);
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})();
