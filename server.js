/**
 * 大肥鱼的手（Minecraft 版）
 *
 * 一个常驻的本地服务：她用 HTTP 说话，这里替她在世界里动手。
 * Python 那边（AstrBot 插件）负责把下面这些接口包成她能调的工具。
 *
 * 端口：127.0.0.1:8765（可用 HER_MC_PORT 改）
 * 事件流水 / 记账日志：写到 HER_MC_DATA 目录下（默认 D:/AstrBot，Windows 以外请务必改）
 * 所有路径与账号都能用环境变量覆盖，见 README。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const PORT = Number(process.env.HER_MC_PORT || 8765);
// 路径都能用环境变量改，默认值留给原作者的环境；别人 clone 下来只改环境变量即可
const DATA_DIR = process.env.HER_MC_DATA || 'D:/AstrBot';
const DEEDS = process.env.HER_MC_DEEDS || path.join(DATA_DIR, '_她做过的事.log');
const GAME_LOG = process.env.HER_MC_LOG || path.join(DATA_DIR, '_她玩MC了.log');

let bot = null;
let joining = false;
let stats = { joinedAt: 0, mined: {}, made: {}, placed: 0, deaths: 0, said: 0 };
let home = null;   // 出生点，脱困用

// 主人在游戏里说的话，攒着等插件那头来取（取走即清空）
// 主人在游戏里的 ID。必须用环境变量 HER_MC_OWNER 指定，否则收不到主人的话。
const OWNER = process.env.HER_MC_OWNER || '';
let inbox = [];
let inboxSeq = 0;

// 这一列最高的实地在哪儿
function surfaceY(x, z) {
  const Vec3 = require('vec3').Vec3;
  for (let y = 200; y > -60; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
    if (b && b.name !== 'air' && b.name !== 'cave_air' && !b.name.includes('leaves')) {
      return y + 1;
    }
  }
  return null;
}

// 取她所在那一片的地面高度，判断她是不是掉到地下了。
// 必须在她进服之后、区块到齐了再量——spawn 那一瞬间区块还没到，量出来是空的。
let homeAt = 0;
function ensureHome() {
  if (!bot || !bot.entity) return;
  if (home && Date.now() - homeAt < 30000) return;
  const p = bot.entity.position;
  const vals = [];
  for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8],
    [8, 8], [-8, -8], [8, -8], [-8, 8], [16, 0], [0, 16]]) {
    const v = surfaceY(p.x + dx, p.z + dz);
    if (v != null) vals.push(v);
  }
  if (vals.length) {
    // 取中位数，不取最高——周围有山头的话，取最高会让她以为自己一直在坑里
    vals.sort((a, b) => a - b);
    const mid = vals[Math.floor(vals.length / 2)];
    home = { x: Math.round(p.x), y: mid, z: Math.round(p.z) };
    homeAt = Date.now();
  }
}

// ── 落地文件 ────────────────────────────────────────────
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function logLine(file, kind, text) {
  const { date, time } = stamp();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${date}  ${time}  ${kind}  ${text}\n`, 'utf8');
  } catch (e) {
    console.error('[log] 写不进去', e.message);
  }
}

const deed = (kind, text) => logLine(DEEDS, kind, text);
const trace = (kind, text) => logLine(GAME_LOG, kind, text);

// ── 状态快照 ────────────────────────────────────────────
function state() {
  if (!bot || !bot.entity) {
    return { online: false, hint: '还没上线' };
  }
  const p = bot.entity.position;
  const inv = {};
  for (const it of bot.inventory.items()) {
    inv[it.name] = (inv[it.name] || 0) + it.count;
  }
  const held = bot.heldItem ? bot.heldItem.name : null;
  const bad = hostiles(16);
  return {
    online: true,
    username: bot.username,
    pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
    health: Math.round(bot.health),
    food: Math.round(bot.food),
    dim: bot.game.dimension,
    time: bot.time.timeOfDay,
    held,
    weapon: bestWeaponName(),
    nearby_hostiles: bad.slice(0, 6).map((x) => `${x.cn} ${x.d}格`),
    inventory: inv,
    hotbar: hotbarSlots(),
    players: Object.keys(bot.players || {}),
    mined: stats.mined,
    made: stats.made,
  };
}

// 把周围环境说成人话，不是坐标表
function around(radius = 12) {
  if (!bot || !bot.entity) return { online: false };
  const p = bot.entity.position;
  const counts = {};
  const mcData = require('minecraft-data')(bot.version);
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (!b || b.name === 'air' || b.name === 'cave_air') continue;
        counts[b.name] = (counts[b.name] || 0) + 1;
      }
    }
  }
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}×${v}`);

  const nearby = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity) continue;
    if (e.type === 'player') nearby.push(`玩家 ${e.username}`);
    else if (e.name) nearby.push(`${e.name}（${e.type}）`);
  }

  return {
    online: true,
    pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
    blocks: top,
    entities: [...new Set(nearby)].slice(0, 10),
    light: bot.entity.position.y > 60 ? '在地面上' : '在地下或洞里',
  };
}

// ── 动作 ────────────────────────────────────────────────
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function walkTo(x, y, z, opts = {}) {
  if (!bot) throw new Error('还没上线');
  const { Movements: M, goals: G } = require('mineflayer-pathfinder');
  const m = new M(bot);
  // 走路默认不乱挖，省内存也不破坏地形；
  // 捡掉落物要用 dig:true——不然她挖出来的坑自己下不去，东西就烂在里头
  m.canDig = !!opts.dig;
  // 脱困时才允许往上垒（挖自己脚下的方块垫上去）。
  // 不许的话，她掉进十几格深的洞里会一直"水平走到家正下方"然后上不来。
  m.allow1by1towers = !!opts.tower;
  m.maxDropDown = 2;           // 别为了走一步算整张地图
  m.allowParkour = false;
  m.allowSprinting = true;
  bot.pathfinder.setMovements(m);
  bot.pathfinder.thinkTimeout = 4000;
  bot.pathfinder.tickTimeout = 20;
  // 超时就放弃，不然一个走不到的目标能把内存吃干净（2026-11-13 崩过一次）
  await Promise.race([
    bot.pathfinder.goto(new G.GoalNear(x, y, z, 1)),
    wait(15000),
  ]);
  try {
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);
  } catch (e) {
    /* ignore */
  }
  // 走没走到要说实话，别像以前那样嘴上说走了、位置没动
  const now = bot.entity.position;
  const far = Math.hypot(now.x - x, now.z - z);
  const dy = Math.abs(now.y - y);
  // 两档精度：赶路/回家/够东西用严的（3~4 格）；
  // 溜达、找资源只要"这一带到了"就算到（6 格），不然 30 格的 roam
  // 差 4 格也要报一句"没走到，卡在 x,y,z"，日志里全是失败。
  const nearXZ = opts.loose ? 6 : 3;
  const nearY = opts.loose ? 6 : 4;
  // y 也得比。只看水平距离的话，她站在目标正下方就报"走到了"，
  // 而念头那边按高度判定"还没上去"，于是一个"爬回地面"能死循环半小时。
  if (far > nearXZ || dy > nearY) {
    return `没走到，卡在 ${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)}`;
  }
  return `走到了 ${Math.round(x)},${Math.round(y)},${Math.round(z)} 附近`;
}

// ── 背包与工具 ──────────────────────────────────────────
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'cherry_log', 'mangrove_log'];
const PLANK_OF = {
  oak_log: 'oak_planks', birch_log: 'birch_planks', spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks', acacia_log: 'acacia_planks', dark_oak_log: 'dark_oak_planks',
  cherry_log: 'cherry_planks', mangrove_log: 'mangrove_planks',
};
// 每样东西要什么料。够不够由下面 ensure 系列去凑。
const NEED = {
  crafting_table: [['planks', 4]],
  stick: [['planks', 2]],
  wooden_pickaxe: [['planks', 3], ['stick', 2]],
  wooden_axe: [['planks', 3], ['stick', 2]],
  wooden_shovel: [['planks', 1], ['stick', 2]],
  wooden_sword: [['planks', 2], ['stick', 1]],
  stone_pickaxe: [['cobblestone', 3], ['stick', 2]],
  stone_axe: [['cobblestone', 3], ['stick', 2]],
  stone_sword: [['cobblestone', 2], ['stick', 1]],
  furnace: [['cobblestone', 8]],
  torch: [['coal', 1], ['stick', 1]],
  leather_helmet: [['leather', 5]],
  leather_chestplate: [['leather', 8]],
  leather_leggings: [['leather', 7]],
  leather_boots: [['leather', 4]],
  chest: [['planks', 8]],
  wooden_hoe: [['planks', 2], ['stick', 2]],
  stone_hoe: [['cobblestone', 2], ['stick', 2]],
  bed: [['wool', 3], ['planks', 3]],
};
const TOOL_RANK = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

function inv() {
  const m = {};
  for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count;
  return m;
}

// 木板够不够，要看**单一种类**。箱子要 8 块同色木板，
// 把云杉 6 块和橡木 4 块加一起算 10 块，配方照样出不来（踩过）。
function singleWool(I) {
  const names = Object.keys(I).filter((n) => n.endsWith('_wool') && I[n] > 0);
  if (!names.length) return 0;
  return Math.max(...names.map((n) => I[n]));
}

function singlePlanks(I) {
  const names = Object.keys(I).filter((n) => n.endsWith('_planks') && I[n] > 0);
  if (!names.length) return 0;
  return Math.max(...names.map((n) => I[n]));
}

// 真实快捷栏 9 格（36..44）。
// inventory 那份是按名字加总的，画到 HUD 上会变成"铁剑×3"—— 原版不存在这种东西，
// 三把剑就是三个格子、每格不显示数字。所以给 HUD 单独留一份按格子的。
function hotbarSlots() {
  try {
    const s = bot.inventory.slots;
    if (!s) return null;
    const out = [];
    for (let i = 36; i <= 44; i++) {
      const it = s[i];
      out.push(it ? { name: it.name, count: it.count } : null);
    }
    return out;
  } catch (e) {
    return null;
  }
}
function total(I, names) { return names.reduce((s, n) => s + (I[n] || 0), 0); }
function plankNames(I) { return Object.keys(I).filter((n) => n.endsWith('_planks') && I[n] > 0); }

function rank(name) {
  const i = TOOL_RANK.findIndex((r) => name.startsWith(r + '_'));
  return i < 0 ? 99 : i;
}
function bestTool(I, kind) {
  const pool = Object.keys(I).filter((n) => n.endsWith('_' + kind) && I[n] > 0);
  pool.sort((a, b) => rank(a) - rank(b));
  return pool[0] || null;
}

// 这种方块要不要工具才能掉东西。要，而手上没有，就别敲——敲了只是白毁地形。
function toolFor(blockName) {
  const md = require('minecraft-data')(bot.version);
  const def = md.blocksByName[blockName];
  if (!def || !def.harvestTools) return { need: false, tool: null };
  const ids = Object.keys(def.harvestTools).map(Number);
  const cands = bot.inventory.items().filter((i) => ids.includes(i.type));
  if (!cands.length) return { need: true, tool: null };
  cands.sort((a, b) => rank(a.name) - rank(b.name));
  return { need: true, tool: cands[0] };
}

// ── 制作（2026-11-13 加的一套手）────────────────────────
// 之前她空手敲石头：敲碎 176 个，一块不掉。MC 不给，因为没镐。
// 这一层把「木头→木板→工作台→木镐」补上，她才有一条能走通的路。
async function ensurePlanks(min = 4) {
  const md = require('minecraft-data')(bot.version);
  for (let i = 0; i < 4; i++) {
    const I = inv();
    if (singlePlanks(I) >= min) return true;
    const log = LOGS.find((l) => (I[l] || 0) > 0);
    if (!log) return false;
    const r = bot.recipesFor(md.itemsByName[PLANK_OF[log]].id, null, 1, null)[0];
    if (!r) return false;
    await bot.craft(r, 1, null);
  }
  const J = inv();
  return singlePlanks(J) >= min;
}

async function ensureSticks(min = 2) {
  const md = require('minecraft-data')(bot.version);
  for (let i = 0; i < 4; i++) {
    if ((inv().stick || 0) >= min) return true;
    if (!(await ensurePlanks(2))) return false;
    const r = bot.recipesFor(md.itemsByName.stick.id, null, 1, null)[0];
    if (!r) return false;
    await bot.craft(r, 1, null);
  }
  return (inv().stick || 0) >= min;
}

// 把东西放到脚边地上，放住了就把方块返回
async function placeNear(name) {
  const Vec3 = require('vec3').Vec3;
  const it = bot.inventory.items().find((i) => i.name === name);
  if (!it) return null;
  try {
    await bot.equip(it, 'hand');
  } catch (e) {
    return null;
  }
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const spots = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
    [0, 1, 0], [0, -1, 0]];
  // 草、花、雪片这些是能直接盖掉的，洞里挖完常留一层
  const SOFT = new Set(['short_grass', 'grass', 'tall_grass', 'large_fern',
    'fern', 'snow', 'dead_bush', 'vine', 'dandelion', 'poppy', 'torch']);
  for (const [dx, dy, dz] of spots) {
    const target = new Vec3(bx + dx, by + dy, bz + dz);
    const air = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!air) continue;
    if (air.name !== 'air' && !SOFT.has(air.name)) continue;
    if (!below || below.name === 'air') continue;
    if (below.name.includes('water') || below.name.includes('lava')) continue;
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      await wait(400);
      const placed = bot.blockAt(target);
      if (placed && placed.name === name) {
        // 带坐标记，不然她只知道"放过一个箱子"，问在哪儿就答不上来
        deed('放置', `${name} 在 ${target.x},${target.y},${target.z}`);
        return placed;
      }
      trace('放置失败', `${name} @${target.x},${target.y},${target.z} 放下去变成 ${placed ? placed.name : '空'}`);
    } catch (e) {
      trace('放置失败', `${name} @${target.x},${target.y},${target.z} ${String(e.message).slice(0, 60)}`);
    }
  }
  return null;
}

async function ensureTable() {
  const md = require('minecraft-data')(bot.version);
  const found = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 20 });
  if (found) {
    let p = bot.entity.position;
    if (found.position.distanceTo(p) > 3) {
      try {
        await Promise.race([
          walkTo(found.position.x, found.position.y, found.position.z, { dig: true }),
          wait(8000),
        ]);
      } catch (e) {
        /* 走不过去就自己再放一个 */
      }
    }
    p = bot.entity.position;
    const near = bot.blockAt(found.position);
    // 够得着才算数。隔着老远点它会卡在 windowOpen 超时 20 秒（踩过）。
    if (near && near.name === 'crafting_table' && near.position.distanceTo(p) <= 4) {
      return near;
    }
  }
  if (!(inv().crafting_table > 0)) {
    if (!(await ensurePlanks(4))) return null;
    const r = bot.recipesFor(md.itemsByName.crafting_table.id, null, 1, null)[0];
    if (!r) return null;
    await bot.craft(r, 1, null);
  }
  return placeNear('crafting_table');
}

// 这些是 3×3 的，必须站在工作台前做
const NEEDS_TABLE = new Set(['wooden_pickaxe', 'wooden_axe', 'wooden_shovel',
  'wooden_sword', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace', 'chest']);

async function craftItem(name, count = 1) {
  if (!bot) throw new Error('还没上线');
  const md = require('minecraft-data')(bot.version);
  // 模型经常把"煤"写成 coal、把床写成 bed，这些名字游戏里其实不存在
  const ALIAS = { bed: 'white_bed', wool: 'white_wool', carpet: 'white_carpet' };
  if (!md.itemsByName[name] && ALIAS[name]) name = ALIAS[name];
  const item = md.itemsByName[name];
  if (!item) return `我不认识「${name}」这种东西`;
  count = Math.max(1, Math.min(16, Number(count) || 1));

  // 先把工作台备好，再备料。
  // 顺序反过来会出事：做工作台要吃掉 4 块木板，正好把做镐的料吃光
  //（2026-11-13 实测，结果卡在「有料但没配方」）。
  // 床有 16 种颜色（white_bed / red_bed …），没有叫 bed 的东西，
  // 判断要不要工作台得看后缀
  const isBed = name.endsWith('_bed');
  let table = null;
  if (NEEDS_TABLE.has(name) || isBed) {
    table = await ensureTable();
    if (!table) return '工作台没弄出来，做不了';
  }

  const recipe = NEED[name] || (isBed ? [['wool', 3], ['planks', 3]] : []);
  for (const [kind, n] of recipe) {
    let ok = false;
    if (kind === 'planks') ok = await ensurePlanks(n * count);
    else if (kind === 'stick') ok = await ensureSticks(n * count);
    else if (kind === 'cobblestone') ok = (inv().cobblestone || 0) >= n * count;
    else if (kind === 'wool') ok = singleWool(inv()) >= n * count;
    else if (kind === 'coal') ok = ((inv().coal || 0) + (inv().charcoal || 0)) >= n * count;
    else if (kind === 'leather') ok = (inv().leather || 0) >= n * count;
    if (!ok) return `料不够，做不了${name}（缺${kind}）`;
  }

  let rs = bot.recipesFor(item.id, null, 1, table);
  if (!rs.length && !table) {
    table = await ensureTable();
    if (table) rs = bot.recipesFor(item.id, null, 1, table);
  }
  if (!rs.length && table) {
    // 工作台刚放下时服务端还没同步完，等一下再问一次
    await wait(700);
    rs = bot.recipesFor(item.id, null, 1, table);
  }
  if (!rs.length) return `有料，但没有${name}的配方`;

  // 工作台得够得着，不然点它不会开窗，只能干等 20 秒超时
  if (table) {
    const d = table.position.distanceTo(bot.entity.position);
    if (d > 4) {
      try {
        await Promise.race([
          walkTo(table.position.x, table.position.y, table.position.z, { dig: true }),
          wait(8000),
        ]);
      } catch (e) {
        /* ignore */
      }
    }
    if (table.position.distanceTo(bot.entity.position) > 5) {
      return '工作台太远，够不着';
    }
  }

  const before = inv();
  try {
    await bot.craft(rs[0], count, table);
  } catch (e) {
    return `做${name}的时候出错了：${String(e.message).slice(0, 60)}`;
  }
  const after = inv();
  const made = (after[name] || 0) - (before[name] || 0);
  if (made <= 0) return `试了，但${name}没出来`;
  stats.made[name] = (stats.made[name] || 0) + made;   // 目标判定要用（"做一个箱子"这种光靠挖数量算不出来）
  deed('做好', `${name} × ${made}`);
  trace('制作', `${name} × ${made}`);
  return `做好了 ${name} × ${made}`;
}

// 从箱子里把东西拿出来。她以前只会往里塞，塞完想用又得重新去挖。
async function takeFromChest(wantItem, need) {
  const KIND = ['chest', 'trapped_chest', 'barrel'];
  let box = null;
  try {
    box = bot.findBlock({
      matching: (b) => !!b && KIND.includes(b.name),
      maxDistance: 32,
    });
  } catch (e) {
    /* ignore */
  }
  if (!box) return '附近没箱子，翻不了';

  let c = null;
  try {
    c = await bot.openContainer(box);
  } catch (e) {
    return `箱子打不开：${String(e.message).slice(0, 30)}`;
  }

  const want = Math.max(1, Number(need) || 16);
  let got = 0;
  try {
    await wait(400);           // 箱子内容要等同步，太急会读到空的
    for (const it of c.containerItems()) {
      if (got >= want) break;
      if (it.name !== wantItem) continue;
      const n = Math.min(want - got, it.count);
      try {
        await c.withdraw(it.type, null, n);
        got += n;
      } catch (e) {
        /* 拿不动就算了，还有别的格子 */
      }
    }
    if (!got) return `箱子里没翻到${wantItem}`;
    stats.made[wantItem] = stats.made[wantItem] || 0;
    deed('取箱', `${wantItem}×${got} ← ${box.position.x},${box.position.y},${box.position.z}`);
    trace('取箱', `${wantItem}×${got}`);
    return `从箱子里拿了 ${wantItem}×${got}`;
  } finally {
    try {
      await c.close();
    } catch (e) {
      /* ignore */
    }
  }
}

// 天黑了躺下睡。床做出来不会躺，等于白做——之前就是这样，
// 铺了床还是贴着洞壁站一宿。
async function sleepInBed() {
  let bed = null;
  try {
    bed = bot.findBlock({
      matching: (b) => !!b && b.name.endsWith('_bed'),
      maxDistance: 24,
    });
  } catch (e) {
    /* ignore */
  }
  if (!bed) return '这附近没床，睡不成';

  const tod = bot.time.timeOfDay;
  const isNight = tod > 12500 && tod < 23400;
  if (!isNight) return '天还亮着，躺下也睡不着';

  try {
    // 别让一次睡眠把整个循环挂住：超时就自己醒来接着干活
    await Promise.race([
      bot.sleep(bed),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sleep timeout')), 90000)),
    ]);
    return '躺下睡了，一觉到天亮';
  } catch (e) {
    try {
      bot.wake();
    } catch (e2) {
      /* ignore */
    }
    const m = String((e && e.message) || '');
    if (/not.*night|daytime|too early/i.test(m)) return '天还亮着，睡不着';
    if (/monster|nearby|player/i.test(m)) return '旁边不干净，躺不下';
    return `躺不下去：${m.slice(0, 40)}`;
  }
}

// 做个箱子放下来——她嘴上说"收拾圆石"说了两轮，手上一直没这活儿。
// 顺序有讲究：先做（要吃掉 8 块木板），再找地方放（放不稳就拎着走，
// 不能为了放箱子把刚做好的拆了）。
async function makeAndPlaceChest() {
  const I0 = inv();
  if (!(I0.chest > 0)) {
    const r = await craftItem('chest');
    if (r.indexOf('做好了') < 0) return r;          // 料不够、没配方之类，原话带回去
  }
  const placed = await placeNear('chest');
  if (!placed) return '这块地方太挤，箱子摆不下';

  // 放下了就真往里塞点东西，"收拾圆石"才算落到实处
  let moved = 0;
  try {
    const c = await bot.openContainer(placed);
    for (const it of bot.inventory.items()) {
      if (!['cobblestone', 'dirt', 'gravel', 'andesite', 'granite'].includes(it.name)) continue;
      // 手上得留点料。全塞进去之后天黑想垒个墙，掏出两块就没了（20:34 真发生）。
      const keep = it.name === 'cobblestone' ? 12 : 4;
      const n = it.count - keep;
      if (n <= 0) continue;
      try {
        await c.deposit(it.type, null, n);
        moved += n;
        // 存了什么、存在哪个箱子，得留一笔。不然过两天问她"我那堆圆石呢"，
        // 她只能瞪眼——箱子就在那儿，她自己不记得往里塞过东西。
        deed('存箱', `${it.name}×${n} → ${placed.position.x},${placed.position.y},${placed.position.z}`);
      } catch (e) {
        /* 塞不进去就算了，别把这一步当成失败 */
      }
    }
    await c.close();
  } catch (e) {
    trace('箱子', `打开失败 ${String(e.message).slice(0, 50)}`);
  }
  if (moved > 0) return `箱子放好了，往里塞了 ${moved} 个石头`;
  return '箱子放好了，脚边总算干净点';
}

// ── 过日子：床和窝 ───────────────────────────────────────
// 她原来只有"砍、挖、走"，天黑了照样在野地里晃，不像个人。
// 这两件事是活人的常识：困了要睡，天黑了要有个能躲的地方。
async function gatherWool(need) {
  for (let round = 0; round < 4; round++) {
    if (singleWool(inv()) >= need) return true;
    const sheep = bot.nearestEntity((e) => e.name === 'sheep' && e.position
      && e.position.distanceTo(bot.entity.position) < 48);
    if (!sheep) {
      // 第 1 轮和第 3 轮各往别处走一次，别站在没羊的地方干等
      if (round === 0 || round === 2) {
        trace('找羊', '附近没羊，往别处走走');
        await roamAway(45);
        continue;
      }
      return false;
    }
    try {
      await walkTo(sheep.position.x, sheep.position.y, sheep.position.z, { dig: true });
    } catch (e) {
      /* 走不过去就下一轮再找 */
    }
    // 羊会跑，贴身砍几下，砍死为止
    for (let k = 0; k < 24; k++) {
      if (singleWool(inv()) >= need) return true;
      const s2 = bot.nearestEntity((e) => e.name === 'sheep' && e.position
        && e.position.distanceTo(bot.entity.position) < 6);
      if (!s2) break;
      try {
        await bot.lookAt(s2.position.offset(0, 1.0, 0), true);
        bot.attack(s2);
      } catch (e) {
        /* ignore */
      }
      await wait(550);
    }
    await wait(800);   // 等羊毛飘过来
  }
  return singleWool(inv()) >= need;
}

async function makeBed() {
  const I = inv();
  // 床有 16 种颜色，物品名都是 xxx_bed，没有叫 bed 的
  const haveBed = Object.keys(I).find((n) => n.endsWith('_bed') && I[n] > 0);
  if (haveBed) {
    const placed = await placeNear(haveBed);
    return placed ? '把床铺上了' : '床有，就是没找着地方铺';
  }
  if (singleWool(I) < 3) {
    const got = await gatherWool(3);
    if (!got) return '这附近一只羊都没有，床做不成';
  }
  // 用手里哪种羊毛就做哪种颜色的床
  const J = inv();
  const woolName = Object.keys(J).find((n) => n.endsWith('_wool') && J[n] >= 3) || 'white_wool';
  const bedName = woolName.replace('_wool', '_bed');
  const r = await craftItem(bedName);
  if (r.indexOf('做好了') < 0) return r;
  const placed = await placeNear(bedName);
  return placed ? '床做好了，铺地上了' : '床做好了，没找着平地铺';
}

// 计划里写"弄 N 个羊毛"时走这条
async function gatherWoolFor(need = 3) {
  const ok = await gatherWool(Math.max(1, Number(need) || 3));
  return ok ? `弄到 ${singleWool(inv())} 个羊毛` : '转了半圈，一只羊都没逮着';
}

// 没床没房，最实在的办法是往山体里掏个洞钻进去
async function digShelter() {
  const V = require('vec3').Vec3;
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const front = bot.blockAt(new V(bx + dx, by, bz + dz));
    const inner = bot.blockAt(new V(bx + dx * 2, by, bz + dz * 2));
    if (!front || !inner) continue;
    if (front.name === 'air' || inner.name === 'air') continue;
    if (/water|lava|bedrock/.test(front.name) || /water|lava|bedrock/.test(inner.name)) continue;
    try {
      await bot.dig(front);
      await bot.dig(inner);
    } catch (e) {
      continue;
    }
    try {
      await walkTo(bx + dx * 2 + 0.5, by, bz + dz * 2 + 0.5, { dig: true });
    } catch (e) {
      /* ignore */
    }
    // 进去之后把口堵上，不然跟站在外面没区别
    const I = inv();
    const mat = ['cobblestone', 'dirt', 'gravel', 'oak_planks', 'spruce_planks']
      .find((n) => (I[n] || 0) > 0);
    if (mat) {
      try {
        const it = bot.inventory.items().find((i) => i.name === mat);
        const floor = bot.blockAt(new V(bx + dx * 2, by - 1, bz + dz * 2));
        if (it && floor) {
          await bot.equip(it, 'hand');
          if (bot.blockAt(new V(bx + dx, by, bz + dz)).name === 'air') {
            await bot.placeBlock(floor, new V(0, 1, 0));
          }
        }
      } catch (e) {
        /* 堵不上就算了，别卡在这一步 */
      }
    }
    return '往山体里掏了个洞，今晚先这么过';
  }
  // 四周都是空地（草原、沙漠这种），没墙可依，就往脚下掏个坑蹲着
  try {
    const under = bot.blockAt(new V(bx, by - 1, bz));
    const under2 = bot.blockAt(new V(bx, by - 2, bz));
    if (under && under2 && under.name !== 'air' && under2.name !== 'air'
        && !/bedrock|water|lava/.test(under.name) && !/bedrock|water|lava/.test(under2.name)) {
      await bot.dig(under);
      await bot.dig(under2);
      return '没墙可依，往脚下掏了个坑蹲着';
    }
  } catch (e) {
    /* ignore */
  }
  return '想找个地方躲，四周全是空的，没处下手';
}

// 饿了自己弄口吃的：先看有没有浆果丛，没有就去找只动物。
// 以前她只会吃现成的，包里空了就只能干饿着。
async function gatherFood(opts = {}) {
  const md = require('minecraft-data')(bot.version);
  try {
    const bush = bot.findBlock({ matching: md.blocksByName.sweet_berry_bush.id, maxDistance: 48 });
    if (bush) {
      try {
        await walkTo(bush.position.x, bush.position.y, bush.position.z, { dig: true });
      } catch (e) {
        /* 走不过去就换动物 */
      }
      const before = inv().sweet_berries || 0;
      try {
        const b = bot.blockAt(bush.position);
        if (b && b.name === 'sweet_berry_bush') await bot.dig(b);
      } catch (e) {
        /* ignore */
      }
      await wait(1000);
      if ((inv().sweet_berries || 0) > before) return '摘了把浆果，先垫垫';
    }
  } catch (e) {
    /* ignore */
  }

  for (const name of ['cow', 'pig', 'chicken', 'sheep']) {
    const animal = bot.nearestEntity((e) => e.name === name && e.position
      && e.position.distanceTo(bot.entity.position) < 48);
    if (!animal) continue;
    try {
      await walkTo(animal.position.x, animal.position.y, animal.position.z, { dig: true });
    } catch (e) {
      continue;
    }
    for (let k = 0; k < 18; k++) {
      const a = bot.nearestEntity((e) => e.name === name && e.position
        && e.position.distanceTo(bot.entity.position) < 6);
      if (!a) break;
      try {
        await equipWeapon();
        await bot.lookAt(a.position.offset(0, 0.8, 0), true);
        bot.attack(a);
      } catch (e) {
        /* ignore */
      }
      await wait(550);
      const I = inv();
      if ((I.beef || 0) + (I.porkchop || 0) + (I.chicken || 0) + (I.mutton || 0) > 0) break;
    }
    await wait(900);
    const I = inv();
    if (['beef', 'porkchop', 'chicken', 'mutton'].some((n) => (I[n] || 0) > 0)) {
      return `打了只${cn(name)}，弄到点肉`;
    }
  }
  // 这一片既没浆果也没动物，换个地方再找一次
  if (!opts.roamed) {
    trace('找吃的', '这片没什么可吃的，往别处走');
    await roamAway(40);
    return gatherFood({ roamed: true });
  }
  return '转了一圈没找着能吃的';
}

// ── 种地 ────────────────────────────────────────────────
// 她有 1 个小麦种子在包里躺了半个月。种地是条长线：锄地→下种→等熟→收。
// 这里给她一个能走通的短闭环：有熟的就先收，没有就找块地种下去。
const CROPS = ['wheat', 'carrots', 'potatoes', 'beetroots'];

async function plantFarm() {
  const V = require('vec3').Vec3;
  const md = require('minecraft-data')(bot.version);

  // 1) 手边有熟的先收
  let ripe = null;
  try {
    ripe = bot.findBlock({
      matching: (b) => {
        if (!b || !CROPS.includes(b.name)) return false;
        const pr = b.getProperties ? b.getProperties() : {};
        return Number(pr.age) >= (b.name === 'wheat' ? 7 : 3);
      },
      maxDistance: 24,
    });
  } catch (e) {
    /* ignore */
  }
  if (ripe) {
    try {
      await walkTo(ripe.position.x, ripe.position.y, ripe.position.z, {});
      await bot.dig(bot.blockAt(ripe.position));
      await wait(800);
      deed('收成', `${ripe.name} @${ripe.position.x},${ripe.position.y},${ripe.position.z}`);
      return `收了点${ripe.name === 'wheat' ? '小麦' : '庄稼'}`;
    } catch (e) {
      /* 收不动就往下走，先种新的 */
    }
  }

  // 2) 没锄头先做一把
  let I = inv();
  if (!Object.keys(I).some((n) => n.endsWith('_hoe'))) {
    const r = await craftItem('wooden_hoe');
    if (r.indexOf('做好了') < 0) return r;
    I = inv();
  }

  // 3) 种子
  const seed = ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'].find((n) => (I[n] || 0) > 0);
  if (!seed) return '翻遍背包没种子，这地种不成';

  // 4) 找块土
  const dirtIds = [md.blocksByName.dirt.id, md.blocksByName.grass_block.id].filter(Boolean);
  const soil = bot.findBlock({ matching: (b) => b && dirtIds.includes(b.type), maxDistance: 16 });
  if (!soil) return '附近没有能下种的土';

  try {
    await walkTo(soil.position.x, soil.position.y, soil.position.z, {});
  } catch (e) {
    /* 尽量靠近，够得着就行 */
  }

  // 5) 锄地
  const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
  if (!hoe) return '锄头不知道跑哪去了';
  try {
    await bot.equip(hoe, 'hand');
    await bot.lookAt(soil.position.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(soil);
    await wait(700);
  } catch (e) {
    return `锄地没锄动：${String(e.message).slice(0, 40)}`;
  }

  // 6) 下种
  const farm = bot.blockAt(soil.position);
  if (!farm || farm.name !== 'farmland') return '锄了半天没变成耕地';
  const seeds = bot.inventory.items().find((i) => i.name === seed);
  if (!seeds) return '种子不见了';
  try {
    await bot.equip(seeds, 'hand');
    await bot.placeBlock(farm, new V(0, 1, 0));
    await wait(500);
  } catch (e) {
    return `种子没种下去：${String(e.message).slice(0, 40)}`;
  }
  deed('种地', `${seed} 种在 ${soil.position.x},${soil.position.y},${soil.position.z}`);
  return `找了块地，把${seed === 'wheat_seeds' ? '小麦' : '种子'}埋下去了`;
}

// ── 熔炼 ────────────────────────────────────────────────
// 她有 2 个熔炉、2 块生铁，但从没烧过——生铁在包里躺着永远变不成铁锭。
// 熔炉是生存的分水岭：有它才有铁镐铁剑，生肉也才变成能顶饿的熟肉。
const SMELT = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', cod: 'cooked_cod', salmon: 'cooked_salmon',
  sand: 'glass', cobblestone: 'stone', clay_ball: 'brick',
  oak_log: 'charcoal', spruce_log: 'charcoal', birch_log: 'charcoal',
};
const FUELS = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks',
  'oak_log', 'spruce_log', 'birch_log', 'stick'];

async function ensureFurnace() {
  const md = require('minecraft-data')(bot.version);
  const found = bot.findBlock({ matching: md.blocksByName.furnace.id, maxDistance: 24 });
  if (found) {
    const d = found.position.distanceTo(bot.entity.position);
    if (d > 4) {
      try {
        await walkTo(found.position.x, found.position.y, found.position.z, {});
      } catch (e) {
        /* 走不到就自己做 */
      }
    }
    const b = bot.blockAt(found.position);
    if (b && b.name === 'furnace' && b.position.distanceTo(bot.entity.position) <= 4) return b;
  }
  if (!(inv().furnace > 0)) {
    const r = await craftItem('furnace');
    if (r.indexOf('做好了') < 0) return null;
  }
  return await placeNear('furnace');
}

async function smeltSomething() {
  const I0 = inv();
  const target = Object.keys(SMELT).find((k) => (I0[k] || 0) >= 1);
  if (!target) return '包翻遍了，没有能烧的东西';
  const fuel = FUELS.find((n) => (I0[n] || 0) > 0);
  if (!fuel) return '没柴火，炉子点不着';

  const fb = await ensureFurnace();
  if (!fb) return '熔炉没弄出来';
  await wait(600);   // 刚放下的熔炉要等服务端同步，急着开就是空窗

  let furnace;
  try {
    furnace = await bot.openFurnace(fb);
  } catch (e) {
    return `熔炉打不开：${String(e.message).slice(0, 40)}`;
  }

  const out = [];
  try {
    const fuelItem = bot.inventory.items().find((i) => i.name === fuel);
    const inputItem = bot.inventory.items().find((i) => i.name === target);
    if (!fuelItem || !inputItem) return '原料或柴火忽然没了';
    // 一块煤能烧 8 个，别一次塞满把煤浪费光
    const n = Math.min(inputItem.count, fuelItem.count * 8, 16);
    const fuelUse = Math.min(fuelItem.count, Math.max(1, Math.ceil(n / 8)));
    await furnace.putFuel(fuelItem.type, null, fuelUse);
    await wait(400);
    await furnace.putInput(inputItem.type, null, n);
    await wait(400);

    const fItem = furnace.fuel;
    const iItem = furnace.inputItem();
    trace('熔炼', `投料 燃料=${fItem ? fItem.name + '×' + fItem.count : '空'} 料=${iItem ? iItem.name + '×' + iItem.count : '空'}`);
    if (!fItem) {
      try { await furnace.close(); } catch (e) { /* ignore */ }
      return `柴火(${fuel})塞不进燃料槽`;
    }
    if (!iItem) {
      try { await furnace.close(); } catch (e) { /* ignore */ }
      return `料(${target})塞不进去`;
    }

    const deadline = Date.now() + Math.min(45000, n * 10500 + 6000);
    while (Date.now() < deadline) {
      await wait(1500);
      if (furnace.outputItem()) break;
    }
    while (furnace.outputItem()) {
      const it = furnace.outputItem();
      try {
        await furnace.takeOutput();
        out.push(`${it.name}×${it.count}`);
      } catch (e) {
        // 背包满的时候取不出来，东西还在炉子里，不能当"没烧出来"
        out.push(`${it.name}×${it.count}（炉子里，包里塞不下）`);
        break;
      }
      await wait(300);
    }
  } catch (e) {
    trace('熔炼', `出错 ${String(e.message).slice(0, 60)}`);
  } finally {
    try {
      await furnace.close();
    } catch (e) {
      /* ignore */
    }
  }

  if (out.length) {
    deed('熔炼', out.join('、'));
    trace('熔炼', out.join('、'));
    return `烧出来 ${out.join('、')}`;
  }
  return '守着炉子半天，没出东西';
}

// 她一直是光着身子跟僵尸打的。有皮子就做一套穿上，挨打少掉一半血。
const ARMOR = [
  ['leather_helmet', 'head'],
  ['leather_chestplate', 'torso'],
  ['leather_leggings', 'legs'],
  ['leather_boots', 'feet'],
];

function armorScore() {
  try {
    let n = 0;
    for (const [, slot] of ARMOR) {
      if (bot.inventory.slots && bot.getEquipmentDestSlot) {
        const s = bot.getEquipmentDestSlot(slot);
        if (bot.inventory.slots[s]) n++;
      }
    }
    return n;
  } catch (e) {
    return 0;
  }
}

async function armorUp() {
  let done = 0;
  for (const [item, slot] of ARMOR) {
    // 已经穿着的跳过
    try {
      const cur = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
      if (cur && cur.name === item) continue;
    } catch (e) {
      /* ignore */
    }
    const I = inv();
    if (!(I[item] > 0)) {
      const need = (NEED[item] || [[]])[0][1] || 0;
      if ((I.leather || 0) < need) continue;
      const r = await craftItem(item);
      if (r.indexOf('做好了') < 0) continue;
    }
    const it = bot.inventory.items().find((i) => i.name === item);
    if (!it) continue;
    try {
      await bot.equip(it, slot);
      done++;
    } catch (e) {
      /* 穿不上就算了 */
    }
  }
  if (done) {
    deed('穿戴', `${done} 件皮甲`);
    return `套上了 ${done} 件皮甲`;
  }
  return '皮子不够，甲没做全';
}

// 背包塞满的时候什么都干不成：烧出来的东西取不出、捡不起掉落物。
// 她包里常年躺着十几根原木和一包落叶，需要有个扔东西的常识。
const JUNK = ['leaf_litter', 'dirt', 'gravel', 'andesite', 'diorite', 'granite',
  'spruce_sapling', 'oak_sapling', 'birch_sapling', 'dead_bush', 'short_grass'];

async function cleanupBag() {
  let tossed = 0;
  for (const it of bot.inventory.items()) {
    if (!JUNK.includes(it.name)) continue;
    // 土和砂砾留一点，用得上
    if ((it.name === 'dirt' || it.name === 'gravel') && it.count <= 8) continue;
    try {
      await bot.tossStack(it);
      tossed++;
    } catch (e) {
      continue;
    }
    await wait(250);
    if (tossed >= 5) break;
  }
  if (tossed) {
    deed('清理', `扔了 ${tossed} 样没用的`);
    return `包里太挤了，扔了 ${tossed} 样没用的`;
  }
  return '翻了一遍，没什么该扔的';
}

// 挖之前先确认手上有镐。镐用坏了还空手敲，敲碎一堆石头一块不掉。
async function ensurePick() {
  const I = inv();
  if (Object.keys(I).some((n) => n.endsWith('_pickaxe') && I[n] > 0)) return true;
  const r = await craftItem((inv().cobblestone || 0) >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe');
  return r.indexOf('做好了') >= 0;
}

// 在指定格子放一块。参考方块是它下面那格，所以必须是实心的。
async function putBlock(name, x, y, z) {
  const V = require('vec3').Vec3;
  const below = bot.blockAt(new V(x, y - 1, z));
  if (!below || below.name === 'air' || /water|lava/.test(below.name)) return false;
  try {
    const it = bot.inventory.items().find((i) => i.name === name);
    if (!it) return false;
    await bot.equip(it, 'hand');
    await bot.placeBlock(below, new V(0, 1, 0));
    stats.placed++;
    return true;
  } catch (e) {
    return false;
  }
}

// 垒一圈墙把自己围起来。手上方块不够就退回掏洞。
//
// 2026-11-19：以前只要背包里有 6 块就开垒，可实际要 8 方向 × 2 格高 = 16 块，
// 于是日志里天天是"垒了两块就没料了，墙没围严实"。现在动工前先数料：
//   够 16 块 → 围满一圈；
//   够 8 块  → 缩成 4 方向 × 2 格高的小隔间（至少三面严实）；
//   连 8 块都不够 → 先去备料（挖石头/挖土），备不齐就掏洞，绝不垒半拉子。
const WALL_MATS = ['cobblestone', 'dirt', 'gravel', 'oak_planks', 'spruce_planks'];

function wallStock() {
  const I = inv();
  return WALL_MATS.reduce((s, n) => s + (I[n] || 0), 0);
}

// 每次放之前现挑：石头优先，用完了接土/砂砾/木板。
// 只锁死一种料的话，石头剩 5 块、土有 20 块也照样垒不完。
function pickWallMat() {
  const I = inv();
  return WALL_MATS.find((n) => (I[n] || 0) > 0) || null;
}

async function buildWall(opts = {}) {
  const FULL_RING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const SMALL_RING = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const FULL_NEED = FULL_RING.length * 2;   // 16
  const SMALL_NEED = SMALL_RING.length * 2; // 8

  // 料不够就别动工，先去弄料。只备一轮（restocked 标记），不递归套娃。
  if (wallStock() < SMALL_NEED && !opts.restocked) {
    const stock = wallStock();
    const need = Math.min(SMALL_NEED - stock, 12);
    trace('备料', `手上只有 ${stock} 块方块，先弄 ${need} 块再来垒墙`);
    if (await ensurePick()) await mineBlock('stone', need, { roamed: true });
    if (wallStock() < SMALL_NEED) await mineBlock('dirt', need, { roamed: true });
    if (wallStock() < SMALL_NEED) {
      const s = await digShelter();
      return `料没凑够（${wallStock()}/${SMALL_NEED} 块），${s}`;
    }
    return await buildWall({ ...opts, restocked: true });
  }

  const big = wallStock() >= FULL_NEED;
  const ring = big ? FULL_RING : SMALL_RING;
  const needN = big ? FULL_NEED : SMALL_NEED;

  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const V = require('vec3').Vec3;
  let n = 0;
  for (let dy = 0; dy < 2; dy++) {
    for (const [dx, dz] of ring) {
      const wx = bx + dx;
      const wy = by + dy;
      const wz = bz + dz;
      // 这一格本来就有东西（上一轮垒的、山体、树干），就是已经严实了，算数。
      // 2026-11-19 实测：她在同一处重垒时，8 个位置里 6 个早就垒好了，
      // 只数新放的 2 块，于是报 2/8 又去掏洞——六次之后整步被跳过。
      const cur = bot.blockAt(new V(wx, wy, wz));
      if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && !/water|lava/.test(cur.name)) {
        n++;
        continue;
      }
      const mat = pickWallMat();
      if (!mat) break; // 料见底就收手，别硬放空气
      if (await putBlock(mat, wx, wy, wz)) n++;
    }
  }
  if (n >= needN) {
    if (big) {
      deed('垒墙', `围了一圈 ${n} 块`);
      return `围了一圈墙（${n} 块），背后总算不是空的`;
    }
    deed('垒墙', `小隔间 ${n} 块`);
    return `料不够，先围个小的（${n} 块，只围了四个正面，墙角还漏风）`;
  }
  if (n >= SMALL_NEED) {
    // 料够但有几个位置被树/水挡住，围了大部分——留着缺口就不算垒好。
    // 前面加「没成：」，judgeStep 认这个标记，别让计划当这步已经完成。
    return `没成：只放上 ${n}/${needN} 块，有几个位置被树或水挡住了`;
  }
  if (n >= 2) {
    // 正常不该走到这里（料是先数过的），真到了也别谎报成功
    const s = await digShelter();
    return `墙只起了 ${n} 块就放不上了，${s}`;
  }
  return await digShelter();
}

// 每挖一块都重新确认手里拿的是对的东西。
// 14:28 实测：第一块煤手上是石镐，第二块手上变成土——挖了 39 块煤一块没掉。
// 原因是背包一变，之前缓存的 item 对象就失效了，equip 静默失败，手停在最后一次拿的东西上。
async function equipFor(blockName) {
  const md = require('minecraft-data')(bot.version);
  const def = md.blocksByName[blockName];
  const chk = toolFor(blockName);
  if (!chk.need) return { ok: true, name: bot.heldItem ? bot.heldItem.name : '空手' };
  const ids = Object.keys(def.harvestTools || {}).map(Number);
  const cands = bot.inventory.items().filter((i) => ids.includes(i.type));
  if (!cands.length) return { ok: false, name: null, why: '背包里没有能挖它的工具' };
  cands.sort((a, b) => rank(a.name) - rank(b.name));
  const it = cands[0];
  for (let k = 0; k < 3; k++) {
    try {
      if (!bot.heldItem || bot.heldItem.type !== it.type) {
        const fresh = bot.inventory.items().find((i) => i.type === it.type);
        if (fresh) await bot.equip(fresh, 'hand');
      }
      if (bot.heldItem && bot.heldItem.type === it.type) return { ok: true, name: it.name };
    } catch (e) {
      trace('换工具失败', `${it.name}: ${String(e.message).slice(0, 50)}`);
    }
    await wait(200);
  }
  return { ok: false, name: it.name, why: '工具换不上手' };
}

async function mineBlock(name, count = 1, opts = {}) {
  if (!bot) throw new Error('还没上线');
  const mcData = require('minecraft-data')(bot.version);
  const target = mcData.blocksByName[name];
  if (!target) return `我不认识「${name}」这种方块`;

  // 要工具才掉东西的方块，手上没有就别敲了
  const chk = toolFor(name);
  if (chk.need && !chk.tool) {
    return `手上没有能挖${name}的工具，敲了也不掉东西（得先做把镐）`;
  }

  const start = inv();
  let got = 0;
  for (let i = 0; i < count; i++) {
    // 优先挖跟自己脚下差不多高的方块。往下挖会挖出坑，
    // 掉落物掉进坑里她下不去，等于白挖（12:34 实测 4 个石头只捡到 1 个）。
    const feet = Math.floor(bot.entity.position.y);
    let b = null;
    const cands = bot.findBlocks({ matching: target.id, maxDistance: 24, count: 40 }) || [];
    for (const c of cands) {
      if (Math.abs(c.y - feet) <= 1) {
        b = bot.blockAt(c);
        break;
      }
    }
    if (!b) b = bot.findBlock({ matching: target.id, maxDistance: 24 });
    if (!b) break;
    const bp = b.position.clone();
    try {
      // 先走到旁边，再挖；不走过去硬挖会一直卡着
      try {
        await Promise.race([walkTo(bp.x, bp.y, bp.z), wait(8000)]);
      } catch (e) {
        /* 走不到也试一下直接挖 */
      }
      const fresh = bot.blockAt(bp);
      if (!fresh || fresh.name !== name) continue;
      // 每一块都重新确认手里的工具（原因见 equipFor 上面那段注释）
      const eq = await equipFor(name);
      if (chk.need && !eq.ok) {
        trace('跳过', `${name} 工具没换回来：${eq.why}`);
        continue;
      }
      const heldNow = eq.name || (bot.heldItem ? bot.heldItem.name : '空手');
      const dist = bp.distanceTo(bot.entity.position);
      await bot.dig(fresh);
      got++;
      stats.mined[name] = (stats.mined[name] || 0) + 1;
      trace('挖方块', `${fresh.name}(${bp.x},${bp.y},${bp.z}) 手上${heldNow} 距${dist.toFixed(1)}`);
      // 掉落物就在附近，走过去捡（可能掉好几堆，多试几次）
      await wait(600);
      // 记下这一挖到底生成了什么实体——不靠实体名猜，直接看
      {
        const seen = [];
        for (const e of Object.values(bot.entities)) {
          if (!e || e === bot.entity || !e.position) continue;
          if (e.position.distanceTo(bp) < 5) seen.push(`${e.name || e.type || '?'}@${e.position.distanceTo(bp).toFixed(1)}`);
        }
        trace('掉落', seen.slice(0, 6).join(',') || '空');
      }
      for (let k = 0; k < 3; k++) {
        const near = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bp) < 6);
        if (!near) break;
        try {
          await Promise.race([
            walkTo(near.position.x, near.position.y, near.position.z, { dig: true }),
            wait(4000),
          ]);
        } catch (e) {
          /* ignore */
        }
        await wait(350);
      }
    } catch (e) {
      break;
    }
  }
  if (!got) {
    // 附近一块都没有，别守着这块地反复报"没找到"，走一段再看
    if (!opts.roamed) {
      trace('找路', `附近没${name}，往别处走一段`);
      await roamAway(35);
      return mineBlock(name, count, { roamed: true });
    }
    return `走了段路也没找到「${name}」`;
  }

  // 掉落物吸附回背包有延迟，多等一会儿再对账。
  // 不然会报"一个都没捡到"，其实东西早进包了（14:29 实测：返回说捡到土，背包里多了 5 块煤）。
  await wait(1500);
  const after = inv();
  const gained = [];
  for (const k of Object.keys(after)) {
    const d = (after[k] || 0) - (start[k] || 0);
    if (d > 0) gained.push(`${k}×${d}`);
  }
  if (!gained.length) {
    trace('挖', `${name} × ${got}（什么都没掉）`);
    return `敲了 ${got} 个 ${name}，但一个都没捡到`;
  }
  const text = gained.join('、');
  deed('挖到', text);
  trace('挖', `${name} → ${text}`);
  return `挖了 ${got} 个 ${name}，捡到 ${text}`;
}

async function placeBlock(name, x, y, z) {
  if (!bot) throw new Error('还没上线');
  const mcData = require('minecraft-data')(bot.version);
  const item = mcData.itemsByName[name];
  if (!item) return `背包里的东西不叫「${name}」`;
  const inv = bot.inventory.items().find((i) => i.name === name);
  if (!inv) return `背包里没有 ${name}`;
  await bot.equip(inv, 'hand');
  const ref = bot.blockAt(new (require('vec3').Vec3)(x, y, z));
  if (!ref) return '那个位置看不着';
  await bot.placeBlock(ref, new (require('vec3').Vec3)(0, 1, 0));
  stats.placed++;
  deed('放置', `${name} 在 ${x},${y},${z}`);
  return `放了 ${name}`;
}

// ── 打架（2026-11-13 下午加）────────────────────────────
// 她原来只有「手」，没有「脾气」：怪贴脸也只能站着挨。
// 这一层给她：找目标 → 换武器 → 上去砍 → 血少了跑 → 饿了吃。
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'ravager', 'enderman', 'slime', 'magma_cube',
  'zombie_villager', 'phantom', 'blaze', 'piglin', 'hoglin', 'zoglin',
  'wither_skeleton', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
  'vex', 'evoker', 'breeze',
]);
// 不硬刚的几种：苦力怕贴脸会炸；末影人会瞬移，追不上还白掉血；幻翼一直在头顶盘旋。
// 遇到就绕开，别把血耗在这种打不赢的架上面。
const BOMB = new Set(['creeper', 'enderman', 'phantom']);

const MOB_CN = {
  zombie: '僵尸', husk: '尸壳', drowned: '溺尸', skeleton: '骷髅', stray: '流浪者',
  bogged: '沼骸', spider: '蜘蛛', cave_spider: '洞穴蜘蛛', witch: '女巫',
  pillager: '掠夺者', vindicator: '卫道士', ravager: '劫掠兽', enderman: '末影人',
  slime: '史莱姆', magma_cube: '岩浆怪', zombie_villager: '僵尸村民',
  phantom: '幻翼', blaze: '烈焰人', piglin: '猪灵', hoglin: '疣猪兽',
  zoglin: '僵尸疣猪兽', wither_skeleton: '凋灵骷髅', silverfish: '蠹虫',
  endermite: '末影螨', guardian: '守卫者', elder_guardian: '远古守卫者',
  vex: '恼鬼', evoker: '唤魔者', breeze: '旋风人', creeper: '苦力怕',
};
const cn = (n) => MOB_CN[n] || n;

const WEAPON = {
  netherite_sword: 9, diamond_sword: 8, iron_sword: 7, stone_sword: 6, golden_sword: 5, wooden_sword: 4,
  netherite_axe: 7, diamond_axe: 6, iron_axe: 5, stone_axe: 4, golden_axe: 3, wooden_axe: 3,
};
const FOOD = new Set([
  'bread', 'apple', 'golden_apple', 'carrot', 'baked_potato', 'cooked_beef',
  'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_cod', 'cooked_salmon',
  'beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'potato',
  'sweet_berries', 'melon_slice', 'cookie', 'pumpkin_pie',
]);

// 身边有哪些会打她的东西，按远近排
function hostiles(radius = 16) {
  if (!bot || !bot.entity) return [];
  const p = bot.entity.position;
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue;
    const n = e.name || '';
    if (!HOSTILE.has(n) && !BOMB.has(n)) continue;
    const d = e.position.distanceTo(p);
    if (d > radius) continue;
    out.push({ e, name: n, cn: cn(n), d: Math.round(d * 10) / 10, bomb: BOMB.has(n) });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

function bestWeaponName() {
  const I = inv();
  let best = null;
  for (const n of Object.keys(I)) {
    if (!WEAPON[n] || I[n] <= 0) continue;
    if (!best || WEAPON[n] > WEAPON[best]) best = n;
  }
  return best;
}

async function equipWeapon() {
  const name = bestWeaponName();
  if (!name) return null;
  try {
    const it = bot.inventory.items().find((i) => i.name === name);
    if (!it) return null;
    if (!bot.heldItem || bot.heldItem.name !== name) await bot.equip(it, 'hand');
    return name;
  } catch (e) {
    trace('换武器失败', `${name}: ${String(e.message).slice(0, 60)}`);
    return null;
  }
}

async function eatFood() {
  if (!bot || !bot.entity) return '还没上线';
  if (bot.food >= 20) return '不饿';
  const it = bot.inventory.items().find((i) => FOOD.has(i.name));
  if (!it) return '背包里没吃的';
  try {
    await bot.equip(it, 'hand');
    await bot.consume();
    deed('吃东西', `吃了 ${it.name}`);
    return `吃了 ${it.name}`;
  } catch (e) {
    return `吃不下：${String(e.message).slice(0, 40)}`;
  }
}

// 背对着怪往外走，不是原地站桩
async function flee(from) {
  if (!bot || !bot.entity || !from || !from.position) return;
  const p = bot.entity.position;
  let dx = p.x - from.position.x;
  let dz = p.z - from.position.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const tx = Math.round(p.x + dx * 14);
  const tz = Math.round(p.z + dz * 14);
  try {
    await walkTo(tx, Math.round(p.y), tz);
  } catch (e) {
    /* 跑不掉就算了，别把异常往上抛 */
  }
}

let fighting = false;
let defend = true;          // 被动自卫：怪贴脸就还手

async function fight(opts = {}) {
  if (!bot || !bot.entity) return { ok: false, msg: '还没上线' };
  if (fighting) return { ok: false, msg: '手上正打着呢' };
  const maxSec = Math.max(5, Math.min(40, Number(opts.seconds || 20)));
  const list = hostiles(Number(opts.radius || 16));
  if (!list.length) return { ok: true, msg: '附近没看见怪', killed: 0 };

  // 血少先顾命，不逞强
  if (bot.health <= 6 && bot.food <= 18) await eatFood();
  if (bot.health <= 6 && !opts.force) {
    await flee(list[0].e);
    deed('逃跑', `血只剩 ${Math.round(bot.health)}，从${list[0].cn}那儿跑了`);
    return { ok: true, msg: `血只剩 ${Math.round(bot.health)}，先跑了`, killed: 0 };
  }

  const target = list.find((x) => !x.bomb);
  if (!target) {
    await flee(list[0].e);
    deed('躲开', `碰到${list[0].cn}，绕开了`);
    return { ok: true, msg: `只有${list[0].cn}，会炸，躲开了`, killed: 0 };
  }

  // 打之前先掂量一下自己几斤几两。
  // 15:16 实测：她空手、血 1，还冲上去跟两只掠夺者硬刚，直接被打死掉光装备。
  // 空手、血少、对面成群，这三种情况一律不接，先跑。
  const myWeapon = bestWeaponName();
  const TOUGH = new Set(['pillager', 'vindicator', 'ravager', 'witch', 'evoker',
    'wither_skeleton', 'blaze', 'piglin_brute', 'hoglin']);
  const strongCount = list.filter((x) => TOUGH.has(x.name)).length;
  // 掠夺者、劫掠兽这种会拿弩拉开距离的，她拿铁剑追不上，硬拼就是送。
  // 只要场上有这类就不接，直接走人。
  const hasTough = strongCount > 0;
  if (!opts.force && (!myWeapon || bot.health <= 8 || strongCount >= 2 || hasTough)) {
    await flee(target.e);
    const why = !myWeapon ? '手上没家伙'
      : (bot.health <= 8 ? `血只剩 ${Math.round(bot.health)}`
        : (hasTough ? `对面是${target.cn}，打不过`
          : '对面来了一群'));
    deed('躲开', `${why}，没敢上，先躲了`);
    return { ok: true, msg: `${why}，${target.cn}先躲着`, killed: 0 };
  }

  fighting = true;
  holdFor(maxSec * 1000 + 5000);
  const weapon = await equipWeapon();
  const t0 = Date.now();
  let killed = 0;
  let note = '';
  let cur = target;

  try {
    if (bot.food <= 14) note = await eatFood() + '；';
    bot.pvp.attack(cur.e);
    while (Date.now() - t0 < maxSec * 1000) {
      if (!cur.e || cur.e.isValid === false) { killed++; break; }
      if (bot.health <= 4) {
        try { bot.pvp.stop(); } catch (e) { /* ignore */ }
        await flee(cur.e);
        note += `快没血了（${Math.round(bot.health)}），撤了`;
        break;
      }
      const near = hostiles(10).filter((x) => !x.bomb);
      if (!near.length) break;
      if (near[0].e !== cur.e) {
        cur = near[0];
        try { bot.pvp.attack(cur.e); } catch (e) { /* ignore */ }
      }
      await wait(350);
    }
  } catch (e) {
    note += `打的时候出了点岔子：${String(e.message).slice(0, 50)}`;
  } finally {
    try { bot.pvp.stop(); } catch (e) { /* ignore */ }
    fighting = false;
  }

  const left = hostiles(20).filter((x) => !x.bomb).length;
  const took = Math.round((Date.now() - t0) / 1000);
  const hp = Math.round(bot.health);
  const head = `${weapon ? '拿着' + cn2(weapon) : '空着手'}打${cur.cn}`;
  const tail = killed ? `打死了，用了 ${took} 秒，血 ${hp}` : `没打死，血 ${hp}，周围还剩 ${left} 只`;
  const msg = (note ? note + ' ' : '') + `${head}：${tail}`;
  deed('打怪', msg);
  trace('打怪', `${cur.name} killed=${killed} left=${left} hp=${hp}`);
  return { ok: true, msg, killed, left, health: hp, weapon };
}

// 物品英文名 → 中文（只为了让她说的话像人话）
function cn2(n) {
  const m = { wooden_sword: '木剑', stone_sword: '石剑', iron_sword: '铁剑',
    golden_sword: '金剑', diamond_sword: '钻石剑', netherite_sword: '下界合金剑',
    wooden_axe: '木斧', stone_axe: '石斧', iron_axe: '铁斧', diamond_axe: '钻石斧',
    netherite_axe: '下界合金斧', golden_axe: '金斧' };
  return m[n] || n;
}

async function say(text) {
  if (!bot) throw new Error('还没上线');
  bot.chat(String(text).slice(0, 240));
  stats.said++;
  trace('说话', String(text).slice(0, 80));
  return '说了';
}

async function join(opts = {}) {
  if (joining) return { ok: false, msg: '正在连，等一下' };
  if (bot && bot.entity) return { ok: false, msg: '已经在线上了' };
  joining = true;
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port || 25565);
  const username = opts.username || 'DaFeiYu';
  const version = opts.version || '26.1';

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        joining = false;
        resolve(r);
      }
    };
    try {
      bot = mineflayer.createBot({
        host,
        port,
        username,
        version,
        auth: opts.auth || 'offline',
        hideErrors: true,
      });
    } catch (e) {
      return done({ ok: false, msg: `建不出来：${e.message}` });
    }

    bot.loadPlugin(pathfinder);
    try {
      bot.loadPlugin(require('mineflayer-pvp').plugin);
    } catch (e) {
      console.error('[her_mc] pvp 没挂上', e.message);
    }
    try {
      bot.loadPlugin(require('mineflayer-collectblock').plugin);
    } catch (e) {
      console.error('[her_mc] collectblock 没挂上', e.message);
    }

    bot.once('spawn', () => {
      stats = { joinedAt: Date.now(), mined: {}, made: {}, placed: 0, deaths: 0, said: 0 };
      const p = bot.entity.position;
      // 地面高度等区块到齐再量（见 ensureHome），这里只先清掉旧值
      home = null;
      homeAt = 0;
      deed('上线', `进了世界，站在 ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
      trace('上线', `${host}:${port} as ${username}`);
      done({ ok: true, msg: '进去了', state: state() });
    });

    bot.on('error', (e) => {
      trace('错误', e.message.slice(0, 100));
      if (!settled) done({ ok: false, msg: `连不上：${e.code || e.message}` });
    });

    bot.on('end', (reason) => {
      if (bot && bot.entity) {
        deed('下线', '从世界里退出来了');
        trace('下线', String(reason).slice(0, 60));
      }
      bot = null;
    });

    bot.on('death', () => {
      stats.deaths++;
      const p = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
      deed('死了', `死在 ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
      trace('死亡', `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
    });

    // 有人在游戏里跟她说话，记下来（她自己会看到聊天框，这里只做记录）
    bot.on('chat', (user, msg) => {
      if (user === bot.username) return;
      trace('聊天', `${user}: ${msg}`.slice(0, 120));
      // 只有主人说话才转给她。别人说话就当没听见，免得她在大厅里乱接话。
      if (user === OWNER) {
        inbox.push({ id: ++inboxSeq, from: user, text: String(msg).slice(0, 200), at: Date.now() });
        if (inbox.length > 50) inbox.shift();
        trace('待回', `${msg}`.slice(0, 80));
      }
    });

    // 挨打就还手——不管那东西在几格外。
    // 骷髅、掠夺者、女巫都站在 8~12 格外面射她，5 格的自卫圈根本够不着，
    // 结果就是她站着挨箭不吭声。
    let lastHurtAt = 0;
    bot.on('entityHurt', (ent) => {
      if (!ent || ent !== bot.entity) return;
      if (Date.now() - lastHurtAt < 1200) return;
      lastHurtAt = Date.now();
      const list = hostiles(16).filter((x) => !x.bomb);
      if (!list.length) return;
      // 先把手上攥着的活停下。她被打的时候十有八九正在挖矿或赶路，
      // 不打断的话那个 await 能拖十几秒，等动作结束人已经躺下了。
      try {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(null);
      } catch (e) {
        /* ignore */
      }
      const hasWeapon = !!bestWeaponName();
      trace('挨打', `被${list[0].cn}打了（${list[0].d}格），${hasWeapon ? '还手' : '先跑'}`);
      if (fighting) return;
      if (hasWeapon) fight({ seconds: 15, radius: 14 }).catch(() => {});
      else flee(list[0].e).catch(() => {});
    });

    setTimeout(() => done({ ok: false, msg: '连了 20 秒没进去' }), 20000);
  });
}

async function quit() {
  if (!bot) return { ok: true, msg: '本来就没在线' };
  try {
    bot.quit('主人让我下');
  } catch (e) {
    /* ignore */
  }
  bot = null;
  return { ok: true, msg: '下来了' };
}

// ── 自己玩 ──────────────────────────────────────────────
// 无人陪的时候用：按一个粗目标自己干，不问她、不等指令。
// 只做"手"的层面（砍、挖、走），像不像人靠后面对素材配音补。
let auto = { on: false, until: 0, hold: 0, task: 'idle', done: [] };

// 主人通过工具直接下的指令：让自主循环先退开 25 秒，免得两只手抢同一件事
function holdFor(ms = 25000) {
  auto.hold = Date.now() + ms;
}

// ── 念头 ────────────────────────────────────────────────
// 2026-11-13 下午改：主人要的不是"任务清单"，是她自己想干啥就干啥。
// 所以这里不再是"缺什么补什么"，只剩三层：活命的本能 → 当下的处境 → 随机冒出来的念头。
const WHIM_LINES = [
  '这儿的树还挺多',
  '天怎么又快黑了',
  '脚有点酸',
  '这块地不错啊',
  '嗯……往哪边走呢',
  '有点饿了',
  '这石头真硬',
  '风好像挺大',
  '我是不是走太远了',
  '这里好安静',
  '想找地方坐会儿',
  '那边好像有水声',
  '再走一会儿就回去',
  '这棵树长得好歪',
  '肚子叫了',
  '刚才那只是僵尸吧',
];
const recentWhims = [];   // 最近几个念头，用来降温，免得她站着看八次四周

// ── 今日目标 ────────────────────────────────────────────
// 目标不是写死的清单，是问出来的：_ask_goal.py 拿她自己的话存进 _goal.json。
// 这里只做一件事——把"今天想干的事"折算成权重，让她围着它转，而不是纯抽奖。
const GOAL_FILE = path.join(__dirname, '_goal.json');
let _goalCache = { at: 0, data: null };

function todayGoal() {
  if (Date.now() - _goalCache.at < 60000) return _goalCache.data;
  _goalCache.at = Date.now();
  let g = null;
  try {
    const d = JSON.parse(fs.readFileSync(GOAL_FILE, 'utf8'));
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    if (!d.date || d.date === today) g = d;
  } catch (e) {
    g = null;
  }
  _goalCache.data = g;
  return g;
}

// ── 计划：一步一步往下走 ─────────────────────────────────
// 以前她只有"目标"，动作靠抽签，所以看着像机器。
// 现在目标带一份分步清单：做完一步进下一步；中途饿了、遇怪就先去处理，
// 处理完接着做原来那一步，而不是重新抽一次。
let stepState = { index: -1, base: {} };
let forageFailAt = 0;     // 上次找吃的失败的时间，用来避开死循环
let cleanupFailAt = 0;    // 上次清理失败的时间

function writeGoalRaw(g) {
  try {
    fs.writeFileSync(GOAL_FILE, JSON.stringify(g, null, 2), 'utf8');
    _goalCache = { at: 0, data: null };
  } catch (e) {
    /* ignore */
  }
}

function currentStep() {
  const g = todayGoal();
  if (!g || !Array.isArray(g.steps) || !g.steps.length) return null;
  let idx = Number(g.cursor || 0);
  // 模型偶尔给出做不了的步（比如"合成"却没说合什么），跳过，别在这儿耗到超时
  let skipped = false;
  while (idx < g.steps.length) {
    const st = g.steps[idx];
    const bad = ['craft', 'mine', 'chop'].includes(st.do) && !st.item;
    if (!bad) break;
    trace('计划', `第 ${idx + 1} 步说不清要做什么，跳过`);
    idx++;
    skipped = true;
  }
  if (skipped) {
    g.cursor = idx;
    writeGoalRaw(g);
  }
  if (idx >= g.steps.length) return null;
  if (stepState.index !== idx) {
    stepState = { index: idx, base: inv() };
  }
  return { ...g.steps[idx], index: idx, total: g.steps.length };
}

const STEP_KIND = {
  mine: 'dig', chop: 'chop', craft: 'craft', smelt: 'smelt',
  wall: 'shelter', shelter: 'shelter', plant: 'farm',
  explore: 'explore', box: 'box', bed: 'bed',
};

// 计划里写的是"要什么"（coal/raw_iron），挖的时候得知道对应哪种方块。
// 这个表原来只在 digSomething 里，stepToWhim 判断"是不是方块"时没表可查，
// 于是 mine coal 被当成了打猎，跑出去摘浆果。
const BLOCK_OF = {
  coal: 'coal_ore', raw_iron: 'iron_ore', raw_copper: 'copper_ore',
  raw_gold: 'gold_ore', cobblestone: 'stone', diamond: 'diamond_ore',
  redstone: 'redstone_ore', lapis_lazuli: 'lapis_ore',
  // 这几样只能打猎拿，确实不是挖出来的
  leather: null, beef: null, porkchop: null, chicken: null, mutton: null,
  rabbit: null, feather: null, wool: null,
};

function blockFor(item) {
  if (!item) return '';
  if (Object.prototype.hasOwnProperty.call(BLOCK_OF, item)) return BLOCK_OF[item] || '';
  return item;
}

function stepToWhim(step) {
  let kind = STEP_KIND[step.do] || 'wander';
  if (step.do === 'mine' && step.item) {
    // 羊毛虽然也是一种方块，但她没剪刀，只能去打羊。
    // 这个判断要放在"是不是方块"之前，不然会去挖一个不存在羊毛方块。
    if (step.item.endsWith('_wool')) {
      kind = 'wool';
    } else {
      // 先翻译成方块名再看。coal 本身是物品不是方块，
      // 直接查 blocksByName 会查空，然后误判成"只能去打猎"。
      const target = blockFor(step.item);
      const md = require('minecraft-data')(bot.version);
      if (!target || !md.blocksByName[target]) kind = 'hunt';
    }
  }
  return {
    kind,
    item: step.item || null,
    need: Number(step.need || 0),
    why: `${step.step}（${step.index + 1}/${step.total}）`,
    stepIndex: step.index,
  };
}

function judgeStep(t, msg) {
  const step = (todayGoal().steps || [])[t.stepIndex];
  if (!step) return false;
  // 动作自己带了「没成：」的，先认它。
  // 以前 shelter 只要话里有个「垒/围」就算完成，"垒了两块就没料了"也能过，
  // 于是计划一路往下推，人还站在四面漏风的墙里。现在失败的那几条明确打标记。
  if (/^没成[:：]/.test(String(msg || ''))) return false;
  // 要数量的按背包增量算，其余看动作有没有报错
  if (step.do === 'chop' && step.need) {
    // 砍树不分树种，砍到云杉也算数
    const base = LOGS.reduce((n, x) => n + (stepState.base[x] || 0), 0);
    const have = LOGS.reduce((n, x) => n + (inv()[x] || 0), 0);
    return have - base >= step.need;
  }
  if (step.do === 'mine' && step.item && step.need) {
    // 挖 coal_ore 掉的是 coal，别拿方块名去对背包
    const want = DROP_OF[step.item] || step.item;
    const base = stepState.base[want] || 0;
    return (inv()[want] || 0) - base >= step.need;
  }
  // 靠"没什么词"来判断成功太脆：说辞一改就漏（"塞不下"改了"摆不下"就误判成完成）。
  // 这几类改成认成功话术，说得出来才算是真办成了。
  const OK = {
    craft: /做好了|有的是|已经/,
    box: /放好|塞了|塞进/,
    bed: /铺上|做好了/,
    shelter: /围|掏|垒|钻进去/,
    wall: /围|垒/,
    plant: /埋|种下|种上/,
    smelt: /烧出|熔炼|\d+ ?个/,
    wool: /羊毛/,
  };
  if (OK[step.do]) return OK[step.do].test(msg);

  // 其余动作还是看失败话术，词表一直补下去也不现实，所以宁严勿松：
  // 没把握的就说成没成，多试几次会自己跳过（连续 6 次跳步）。
  return !/没找到|做不了|够不着|不认识|挖不动|打不开|没围|空空|说不成|没出东西|没找着|没地方|走不通|没走到|没弄出来|塞不下|摆不下|太挤|缺|没逮着|没有一只|没处下手|一只羊都没有/.test(msg);
}

function advanceStep(idx, msg) {
  let g = null;
  try {
    g = JSON.parse(fs.readFileSync(GOAL_FILE, 'utf8'));
  } catch (e) {
    return false;
  }
  if (!g || Number(g.cursor || 0) !== idx) return false;
  g.cursor = idx + 1;
  writeGoalRaw(g);
  stepState = { index: -1, base: {} };
  deed('计划', `第 ${idx + 1}/${g.steps.length} 步完了：${g.steps[idx].step}`);
  trace('计划', `${idx + 1}/${g.steps.length} → ${msg}`.slice(0, 120));
  if (g.cursor >= g.steps.length) {
    deed('计划', `这件事做完了：${g.goal}`);
    trace('目标', `完成 ${g.goal}`);
    askNextGoal();
    return true;
  }
  return false;
}

function pickWhim() {
  // 先看自己在哪儿。掉进自己挖的坑里、或者钻到地下很深，
  // 第一件事是爬出去——不然她会一直"往哪边走"却原地不动。
  ensureHome();
  // 掉进坑里要爬，但"正在按计划往下挖"不算掉坑——不然她刚挖下去就被拽上来，
  // 上来又挖，来回拉锯，计划永远停在挖矿那一步。
  const _cur = currentStep();
  const _digging = !!(_cur && ['mine', 'dig'].includes(_cur.do));
  const _dropLimit = _digging ? 30 : 6;
  if (home && bot.entity.position.y < home.y - _dropLimit) {
    return { kind: 'escape', why: '爬回地面' };
  }
  // 有东西贴脸先还手。一边被啃一边砍树，最后树也没了血也没了。
  const bad = hostiles(7).filter((x) => !x.bomb);
  if (bad.length) {
    // 血不到一半就别打了。以前这里无脑还手，血 8 也敢上，
    // 结果一路挨到 1 点血才跑，跑不掉就没了（22:02 死过一次）。
    if (bot.health <= 10) {
      return { kind: 'flee', why: `血只剩 ${Math.round(bot.health)}，先躲开${bad[0].cn}` };
    }
    return { kind: 'fight', why: `打${bad[0].cn}` };
  }

  // 下面全是"想干啥"。没有任务，没有清单，只有一堆念头按当下的处境加权抽一个。
  const I = inv();
  const logs = total(I, LOGS);
  const tod = bot.time.timeOfDay;
  const night = tod > 12800 && tod < 23200;
  const hasPick = !!bestTool(I, 'pickaxe');

  // 本能三：饿得发慌就翻包找吃的
  const hasFoodNow = bot.inventory.items().some((i) => FOOD.has(i.name));
  if (bot.food <= 6 && hasFoodNow) return { kind: 'eat', why: '饿了，找点吃的' };
  // 没吃的时候才出去找。找不着就先饿着干活，别一直空转——
  // 21:27 她连着刷了九次"转了一圈没找着能吃的"，计划一步没动。
  if (bot.food <= 14 && !hasFoodNow && Date.now() - forageFailAt > 90000) {
    return { kind: 'forage', why: '饿了，出去找点吃的' };
  }
  // 血掉得有点狠，先垫一口。
  // 只在不饱的时候吃——饱食度满着是吃不下的，那种情况靠自然回血就够。
  if (bot.health <= 14 && bot.food <= 19 && hasFoodNow) {
    return { kind: 'eat', why: '血不多了，先吃点东西' };
  }
  // 血见底就别再挖矿砍树了。摔一下、被打两下就没了，
  // 这时候最该做的是蹲着别动，等天亮再说（夜里出去找吃的更容易死）。
  if (bot.health <= 6) {
    if (hasFoodNow) return { kind: 'eat', why: '血快没了，先吃点东西' };
    // 白天就出去找吃的——饿着回不了血，蹲一天也还是 5 点血
    if (!night && Date.now() - forageFailAt > 60000) {
      return { kind: 'forage', why: '血太少了，得找点吃的才回得上来' };
    }
    return { kind: 'idle', why: '血太少了，先蹲着缓一缓' };
  }

  // 包塞爆了什么活都干不下去：烧出来的取不出、掉落物捡不起。这条要走在计划前面。
  if (bot.inventory.items().length >= 34 && Date.now() - cleanupFailAt > 60000) {
    return { kind: 'cleanup', why: '包太满，先扔点没用的' };
  }

  // ★ 有计划就按计划走，不再抽签。
  // 上面那些活命的事已经判过了（爬出坑、还手、吃饭），所以这里可以放心推进进度。
  const step = currentStep();
  if (step) return stepToWhim(step);

  const bag = [];
  const add = (kind, n, why) => { for (let i = 0; i < n; i++) bag.push({ kind, why }); };

  add('wander', night ? 5 : 9, '随便走走');
  add('look', 4, '看看四周');
  add('idle', 3, '站一会儿');
  add('chat', 3, '嘀咕一句');
  add('jump', 2, '蹦两下');
  add('explore', night ? 1 : 5, '往那边走走');
  // 空手也能砍树，别因为包里没木头就不想砍（之前这里写错条件，她重生后连砍树都不想了）
  add('chop', 3, '想砍两下树');
  if (hasPick) add('dig', 4, '挖两下');
  // 木头攒够了就惦记着做个箱子把地上的石头收收——不是任务，是她自己的心思
  const planksNow = singlePlanks(I);
  if (!(I.chest > 0) && (logs >= 3 || planksNow >= 8)) add('box', 4, '想做个箱子收东西');
  // 包快塞满了，先扔点没用的——满了连烧出来的东西都取不出来

  // 有皮子又光着，就想做身甲
  if ((I.leather || 0) >= 4 && armorScore() < 4) add('armor', 6, '想做身皮甲');

  // 有矿有肉又有柴火，就想着烧一炉——生铁不变铁锭，永远做不出铁家伙
  const canSmelt = Object.keys(SMELT).some((k) => (I[k] || 0) > 0)
    && FUELS.some((n) => (I[n] || 0) > 0);
  if (canSmelt) add('smelt', 5, '想烧一炉东西');
  // 有煤没火把，就想做几根备着
  if (((I.coal || 0) + (I.charcoal || 0)) > 0 && (I.torch || 0) < 8) add('torch', 4, '想做几根火把');

  // 手上有种子，就惦记着找块地。白天才有这个闲心。
  if (!night && ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'].some((n) => (I[n] || 0) > 0)) {
    add('farm', 4, '想找块地种点东西');
  }
  if ((I.cobblestone || 0) > 8) add('place', 2, '放两块石头玩玩');
  // 身上圆石见底、附近又有箱子，就去翻翻存货
  if ((I.cobblestone || 0) < 8) {
    let nearBox = null;
    try {
      nearBox = bot.findBlock({ matching: (b) => !!b && b.name === 'chest', maxDistance: 16 });
    } catch (e) {
      /* ignore */
    }
    if (nearBox) add('take', 8, '箱子里还有存货，去拿点圆石');
  }
  if (night) {
    add('look', 3, '夜里留点神');
    add('idle', 2, '不太想动');
    // 天黑就该找地方睡——这是活人的顺序，不是任务清单。
    // 注意别写 I.bed：床叫 white_bed / red_bed，根本没有叫 bed 的物品，
    // 以前这么写她做了床也永远以为自己没床。
    const myBed = Object.keys(I).find((n) => n.endsWith('_bed') && I[n] > 0);
    if (myBed) {
      add('sleep', 14, '困了，躺下睡');
    } else {
      if (singleWool(I) >= 3) add('bed', 10, '困了，想弄张床');
      else add('bed', 5, '想找只羊薅点羊毛做床');
      add('shelter', 9, '天黑前得找个窝');
    }
  } else if (!Object.keys(I).some((n) => n.endsWith('_bed') && I[n] > 0)) {
    // 白天路过羊也会惦记一句：晚上总得有个睡的地方
    if (singleWool(I) >= 3) add('bed', 3, '趁天亮把床做了');
  }

  // 今天想干的事，权重给足——她不是没偏好，是以前没人问她
  const goal = todayGoal();
  if (goal && Array.isArray(goal.want)) {
    for (const k of goal.want) {
      // 旧念头里的 place 只会"扔两块石头玩玩"，真能放东西的是 box，所以 place 当 box 使
      const kind = k === 'place' ? 'shelter' : k;
      if (['chop', 'dig', 'explore', 'wander', 'box', 'bed', 'shelter', 'farm', 'smelt'].includes(kind)) {
        // 天黑了就先把活儿放一放，找地方睡觉更要紧
        add(kind, night ? 5 : 14, goal.short || '今天想干这个');
      }
    }
  }

  const pool = [];
  for (const it of bag) {
    const times = recentWhims.filter((x) => x === it.kind).length;
    for (let i = 0; i < Math.max(1, 3 - times); i++) pool.push(it);
  }
  const got = pool[Math.floor(Math.random() * pool.length)] || { kind: 'wander', why: '随便走走' };
  recentWhims.push(got.kind);
  if (recentWhims.length > 6) recentWhims.shift();
  return got;
}

// ── 各种"念头"怎么落地 ──────────────────────────────────
async function lookAround() {
  for (let i = 0; i < 2; i++) {
    try {
      await bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true);
    } catch (e) { /* ignore */ }
    await wait(900 + Math.random() * 1200);
  }
  return '站着看了会儿四周';
}

async function idleHere() {
  const ms = 2000 + Math.random() * 4000;
  await wait(ms);
  return `站着发了 ${Math.round(ms / 1000)} 秒呆`;
}

async function saySomething() {
  // 有今日目标的时候，一半的话是围绕它的——不然一张嘴全是"天怎么又快黑了"
  const g = todayGoal();
  const useGoal = g && Array.isArray(g.lines) && g.lines.length && Math.random() < 0.5;
  const line = useGoal
    ? g.lines[Math.floor(Math.random() * g.lines.length)]
    : WHIM_LINES[Math.floor(Math.random() * WHIM_LINES.length)];
  try { bot.chat(line); } catch (e) { /* ignore */ }
  trace('自言自语', line);
  await wait(700);
  return `嘟囔了一句「${line}」`;
}

async function jumpAbout() {
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    try {
      bot.setControlState('jump', true);
      await wait(180);
      bot.setControlState('jump', false);
    } catch (e) { /* ignore */ }
    await wait(220);
  }
  return `原地蹦了 ${n} 下`;
}

// 随手砍两下树：不为了做东西，就是路过顺手
async function chopSomething(need) {
  const names = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log'];
  const want = Number(need) || 1 + Math.floor(Math.random() * 2);
  // 这里传 roamed:true，禁掉 mineBlock 自己的"走一段"。
  // 不然 7 个树种各走一趟，一次动作能折腾十几分钟。
  for (const n of names) {
    const msg = await mineBlock(n, want, { roamed: true });
    if (msg.indexOf('挖了') >= 0) return msg;
  }
  // 这一片真没树，换个地方再来一遍
  await roamAway(40);
  for (const n of names) {
    const msg = await mineBlock(n, want, { roamed: true });
    if (msg.indexOf('挖了') >= 0) return `${msg}（走了段路才找到树）`;
  }
  return '走了两趟，附近都没看见能砍的树';
}

// 随便挖两下：土、沙、沙砾空手就行；有镐才去想石头
// 挖出来的东西和方块名对不上：挖煤矿石掉煤、挖石头掉圆石。
// 计划里写的是"要 3 个煤"，判定得看煤，不能看 coal_ore。
const DROP_OF = {
  coal_ore: 'coal', deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  stone: 'cobblestone', grass_block: 'dirt',
};

async function digSomething(wantItem) {
  // 镐用坏了就再做一把。空手敲石头是白敲，一块都不掉。
  if (!(await ensurePick())) return '手上连把镐都没有，挖不动';
  let cand = ['dirt', 'sand', 'gravel', 'stone'];
  // 计划里写的是"要什么东西"，不是"挖什么方块"，这里翻回方块名
  const want = blockFor(wantItem);
  if (want === 'stone') cand = ['stone', 'stone', 'stone', 'gravel'];
  else if (want === 'coal_ore') cand = ['coal_ore', 'coal_ore', 'deepslate_coal_ore'];
  else if (want === 'iron_ore') cand = ['iron_ore', 'iron_ore', 'deepslate_iron_ore'];
  else if (want === 'deepslate_coal_ore') cand = ['coal_ore', 'deepslate_coal_ore'];
  else if (want === 'deepslate_iron_ore') cand = ['iron_ore', 'deepslate_iron_ore'];
  else if (want === 'copper_ore') cand = ['copper_ore', 'stone'];
  else if (want === 'gold_ore') cand = ['gold_ore', 'stone'];
  else if (want) cand = [want, want, 'stone'];
  const name = cand[Math.floor(Math.random() * cand.length)];
  return await mineBlock(name, 1 + Math.floor(Math.random() * 2));
}

// 附近搜不到东西就去别处走一段。她之前站在没树没羊的地方，
// 每一轮都只报"附近没有"，一整晚原地打转。
//
// 2026-11-19：改成"记得哪个方向有货"。以前纯随机，走完就忘，
// 明明西北边有林子，她下一趟可能又往东南的沙地钻。
// 只记一个偏好方位（内存变量，不落盘），够用也不复杂：
//   · 到了地方扫一眼有没有树/矿/动物，有就把这个方位记下来；
//   · 有偏好方位时 65% 概率还往那边走（带一点抖动，免得一条直线撞墙）；
//   · 顺着偏好连走两次都空手，就认为那边被扫光了，清掉偏好重新随机。
let roamPref = { ang: null, misses: 0 };

// 这一带有没有值得留下的东西：树、石头/煤/铁、常见动物
function nearbyGoodies(radius = 24) {
  if (!bot || !bot.entity) return false;
  try {
    const md = require('minecraft-data')(bot.version);
    const ids = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
      'dark_oak_log', 'cherry_log', 'stone', 'coal_ore', 'iron_ore']
      .map((n) => (md.blocksByName[n] ? md.blocksByName[n].id : null))
      .filter((x) => x != null);
    if (bot.findBlock({ matching: ids, maxDistance: radius })) return true;
    const p = bot.entity.position;
    const animal = bot.nearestEntity((e) => e && e.position
      && ['cow', 'pig', 'sheep', 'chicken'].includes(e.name)
      && e.position.distanceTo(p) < radius);
    return !!animal;
  } catch (e) {
    return false;
  }
}

async function roamAway(dist) {
  if (!bot || !bot.entity) return '不在游戏里';
  const p = bot.entity.position.clone();
  const usePref = roamPref.ang != null && Math.random() < 0.65;
  const ang = usePref
    ? roamPref.ang + (Math.random() - 0.5) * 0.6
    : Math.random() * Math.PI * 2;
  const d = dist || 30 + Math.random() * 20;
  const tx = Math.round(p.x + Math.cos(ang) * d);
  const tz = Math.round(p.z + Math.sin(ang) * d);
  try {
    const r = await Promise.race([
      // loose：溜达只要"这一带到了"就算到，别为差 3 格报没走到
      walkTo(tx, Math.round(p.y), tz, { dig: true, loose: true }),
      wait(16000).then(() => '走太慢，先停下'),
    ]);
    let found = false;
    try {
      await wait(400);
      found = nearbyGoodies(24);
    } catch (e) {
      /* 扫不到就当没有 */
    }
    if (found) {
      roamPref = { ang, misses: 0 };
    } else if (usePref) {
      roamPref.misses++;
      if (roamPref.misses >= 2) roamPref = { ang: null, misses: 0 };
    }
    trace('找路', `往 ${tx},${tz} 走一段（${r}${found ? '，这边有东西' : ''}）`.slice(0, 90));
    return r;
  } catch (e) {
    return '这条路不好走';
  }
}

// 往一个方向走远一点，不是回家也不是赶路，就是想看看那边有什么
async function exploreAway() {
  const p = bot.entity.position;
  const angle = Math.random() * Math.PI * 2;
  const dist = 25 + Math.random() * 35;
  const tx = Math.round(p.x + Math.cos(angle) * dist);
  const tz = Math.round(p.z + Math.sin(angle) * dist);
  return await walkTo(tx, Math.round(p.y), tz, { dig: true, loose: true });
}

// 随手放块石头/土，像小孩堆东西
async function placeSomething() {
  const I = inv();
  const block = ['cobblestone', 'dirt', 'spruce_planks', 'oak_planks'].find((n) => (I[n] || 0) > 0);
  if (!block) return '手上没有能放的方块';
  const p = bot.entity.position;
  const bx = Math.floor(p.x) + (Math.random() < 0.5 ? 1 : -1);
  const bz = Math.floor(p.z) + (Math.random() < 0.5 ? 1 : -1);
  try {
    return await placeBlock(block, bx, Math.floor(p.y), bz);
  } catch (e) {
    return '想放一块，结果没放稳';
  }
}

// 手里老攥着一块土走路很难看（寻路挖土挖完不还手），空下来就换回剑或镐
async function holdSomethingSensible() {
  if (!bot || !bot.entity || !bot.heldItem) return;
  const cur = bot.heldItem.name;
  if (/_pickaxe$|_sword$|_axe$|_shovel$/.test(cur)) return;
  const I = inv();
  const want = bestWeaponName() || bestTool(I, 'pickaxe');
  if (!want) return;
  try {
    const it = bot.inventory.items().find((i) => i.name === want);
    if (it) await bot.equip(it, 'hand');
  } catch (e) { /* 换不上就拿着吧，不碍事 */ }
}

// 连续几次挪不动就认栽：她挖出来的 1×1 隧道，走路不许挖就永远出不来
let stuckCount = 0;

async function wander() {
  const p = bot.entity.position;
  const angle = Math.random() * Math.PI * 2;
  const dist = 8 + Math.random() * 10;
  const tx = Math.round(p.x + Math.cos(angle) * dist);
  const tz = Math.round(p.z + Math.sin(angle) * dist);
  const ty = Math.round(p.y);
  // 允许挖：困在自己挖的洞里时，只有挖出来这一条路
  const msg = await walkTo(tx, ty, tz, { dig: true });
  if (msg.indexOf('没走到') >= 0) {
    stuckCount++;
    if (stuckCount >= 2 && home) {
      stuckCount = 0;
      const m2 = await walkTo(home.x, home.y, home.z, { dig: true });
      return `原地挪不动，往地面挖：${m2}`;
    }
    return msg;          // 不再谎报"走了走"
  }
  stuckCount = 0;
  return msg;
}

async function autoLoop() {
  while (auto.on && Date.now() < auto.until && bot && bot.entity) {
    // 手上这份计划干完了就赶紧问下一份，别在这儿空转
    ensureNextGoal();

    // 主人一开口，手先让出来，别跟她抢方向盘
    if (Date.now() < auto.hold) {
      auto.task = '让给主人';
      await wait(1200);
      continue;
    }
    const t = pickWhim();
    auto.task = t.why || t.kind;
    try {
      let msg = '';
      // 手上攥着块土走路太怪了（寻路挖土挖完不还手），空下来就换回剑或镐
      if (['wander', 'look', 'idle', 'chat', 'jump', 'explore'].includes(t.kind)) {
        await holdSomethingSensible();
      }
      if (t.kind === 'mine') {
        // 树不一定都是橡木，挨个试；能找到哪种就用哪种
        const names = t.block === 'oak_log'
          ? ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log']
          : [t.block];
        for (const n of names) {
          msg = await mineBlock(n, t.count);
          if (msg.indexOf('挖了') >= 0) break;
        }
        // 都找不到、或者挖了白挖（掉落物滚下坡够不着），就别在原地重试
        if (msg.indexOf('没找到') >= 0 || msg.indexOf('一个都没捡到') >= 0) {
          msg = (await wander()) + '（这块挖不出东西，换了个地方）';
        }
      } else if (t.kind === 'wander') msg = await wander();
      else if (t.kind === 'look') msg = await lookAround();
      else if (t.kind === 'idle') msg = await idleHere();
      else if (t.kind === 'chat') msg = await saySomething();
      else if (t.kind === 'jump') msg = await jumpAbout();
      else if (t.kind === 'chop') msg = await chopSomething(t.need);
      else if (t.kind === 'dig') msg = await digSomething(t.item);
      else if (t.kind === 'explore') msg = await exploreAway();
      else if (t.kind === 'place') msg = await placeSomething();
      else if (t.kind === 'box') msg = await makeAndPlaceChest();
      else if (t.kind === 'bed') msg = await makeBed();
      else if (t.kind === 'sleep') msg = await sleepInBed();
      else if (t.kind === 'take') msg = await takeFromChest(t.item || 'cobblestone', t.need || 16);
      else if (t.kind === 'forage') {
        msg = await gatherFood();
        if (/没找着|没有能|转了一圈/.test(msg)) {
          forageFailAt = Date.now();
          msg += '（先不找了，饿着接着干）';
        }
      }
      else if (t.kind === 'farm') msg = await plantFarm();
      else if (t.kind === 'smelt') msg = await smeltSomething();
      else if (t.kind === 'armor') msg = await armorUp();
      else if (t.kind === 'cleanup') {
        msg = await cleanupBag();
        if (/没什么该扔/.test(msg)) cleanupFailAt = Date.now();
      }
      else if (t.kind === 'wool') msg = await gatherWoolFor(t.need || 3);
      else if (t.kind === 'hunt') msg = await gatherFood();
      else if (t.kind === 'torch') msg = await craftItem('torch');
      else if (t.kind === 'shelter') msg = await buildWall();
      else if (t.kind === 'eat') msg = await eatFood();
      else if (t.kind === 'flee') {
        const chasing = hostiles(14).filter((x) => !x.bomb);
        if (chasing.length) {
          await flee(chasing[0].e);
          msg = `血只剩 ${Math.round(bot.health)}，先躲开${chasing[0].cn}`;
        } else {
          await roamAway(20);
          msg = '刚才有动静，先挪个地方';
        }
      }
      else if (t.kind === 'fight') {
        const r = await fight({ seconds: 18, radius: 10 });
        msg = r.msg;
      }
      else if (t.kind === 'craft') msg = (t.item === 'bed') ? await makeBed() : await craftItem(t.item, 1);
      else if (t.kind === 'escape') {
        // 允许一路挖上去，先回到地面再说
        msg = await walkTo(home.x, home.y, home.z, { dig: true, tower: true });
        if (msg.indexOf('没走到') >= 0) {
          // 平挖不动就往上挖一格再试
          try {
            const up = bot.blockAt(bot.entity.position.offset(0, 2, 0));
            if (up && up.name !== 'air') await bot.dig(up);
          } catch (e) {
            /* ignore */
          }
          // 连着三趟上不去，说明那条路根本通不了。别惦记原来那个家了，
          // 就地重新记一个，不然她能在这儿转到天亮。
          auto.escFails = (auto.escFails || 0) + 1;
          if (auto.escFails >= 3) {
            const p = bot.entity.position;
            home = { x: Math.round(p.x), y: Math.round(p.y) + 1, z: Math.round(p.z) };
            auto.escFails = 0;
            msg += '（原路不通，改从这儿重新找路）';
          }
        } else {
          auto.escFails = 0;
        }
      }
      // 兜底：同一条路连着走不通三次，就别再原地打转了，换一地儿重来。
      // （之前她能拿一句"缺 stick"重复十几次，一小时的录像全废。）
      // 「没成」是动作自己报的失败（比如墙的位置被树挡住），也算走不通，
      // 连着三次就换个地方重来，别在同一面墙上死磕。
      if (/做不了|没找到|一个都没捡到|够不着|不认识|没成[:：]/.test(msg)) {
        if (auto.lastWhy === t.why) auto.fails = (auto.fails || 0) + 1;
        else { auto.lastWhy = t.why; auto.fails = 1; }
        if (auto.fails >= 3) {
          auto.fails = 0;
          auto.lastWhy = '';
          msg = (await wander()) + '（这条路走不通，先换个地方）';
        }
      } else {
        auto.fails = 0;
        auto.lastWhy = '';
      }
      trace('自己玩', `${t.why} → ${msg}`);

      // 这一步做完了就往前走，不用等整件事
      if (t.stepIndex != null) {
        if (judgeStep(t, msg)) {
          auto.stepFails = 0;
          if (advanceStep(t.stepIndex, msg)) {
            try {
              bot.chat('这步弄完了，接着往下');
            } catch (e) {
              /* ignore */
            }
          }
        } else {
          // 某一步反复做不成（料不够、地方不对），跳过去，别耗到整件事超时
          auto.stepFails = (auto.stepFails || 0) + 1;
          if (auto.stepFails >= 6) {
            auto.stepFails = 0;
            const gg = todayGoal();
            if (gg && Array.isArray(gg.steps) && t.stepIndex < gg.steps.length) {
              gg.cursor = t.stepIndex + 1;
              writeGoalRaw(gg);
              stepState = { index: -1, base: {} };
              deed('计划', `第 ${t.stepIndex + 1} 步做不成，跳过去`);
            }
          }
        }
      }
      auto.done.push(`${stamp().time} ${t.why}：${msg}`);
      if (auto.done.length > 40) auto.done.shift();
    } catch (e) {
      trace('自己玩卡住', `${t.kind}: ${e.message}`.slice(0, 120));
      await wait(3000);
    }
    // 她不是机器，每件事之间有点停顿，长短不一
    await wait(800 + Math.random() * 2200);
  }
  auto.on = false;
  auto.task = 'idle';
  deed('自己玩', '自己玩了一会儿，停下来了');
  trace('自己玩', '结束了');
}

// ── 录屏 ────────────────────────────────────────────────
const { spawn } = require('child_process');
let rec = null;

function recordStart(tag = '') {
  if (rec) return { ok: false, msg: '已经在录了' };
  const dir = process.env.HER_MC_RECORD || path.join(DATA_DIR, '_mc_record');
  fs.mkdirSync(dir, { recursive: true });
  const name = `mc_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${tag ? '_' + tag : ''}.mp4`;
  const out = path.join(dir, name);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '30', '-i', 'title=Minecraft 26.1',
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-b:v', '8M', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out,
  ];
  rec = spawn('ffmpeg', args, { stdio: 'ignore' });
  rec.on('exit', () => {
    rec = null;
  });
  trace('录屏', `开始 ${name}`);
  return { ok: true, msg: `开始录了：${name}`, file: out };
}

function recordStop() {
  if (!rec) return { ok: false, msg: '没在录' };
  const p = rec;
  rec = null;
  p.kill('SIGINT');
  trace('录屏', '停了');
  return { ok: true, msg: '录完了，文件在 _mc_record 里' };
}

// ── 被动自卫 ────────────────────────────────────────────
// 不等指令：怪贴到 5 格内就还手。她原来只会站着挨，一晚上能被啃死三次。
let lastDefend = 0;
setInterval(() => {
  if (!defend || fighting || !bot || !bot.entity) return;
  if (auto.on) return;                 // 自玩时由 pickWhim 统一调度，别两只手抢
  if (Date.now() - lastDefend < 6000) return;
  const list = hostiles(5).filter((x) => !x.bomb);
  if (!list.length) return;
  if (!bestWeaponName()) return;       // 空手别逞强，跑了比送死强
  lastDefend = Date.now();
  fight({ seconds: 12, radius: 7 }).catch(() => {});
}, 1500);

// ── HTTP ────────────────────────────────────────────────
function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const routes = {
  'POST /join': async (q) => join(q),
  'POST /quit': async () => quit(),
  'GET /state': async () => state(),
  'GET /around': async () => around(),
  'POST /walk': async (q) => {
    if (!bot) return { ok: false, msg: '还没上线' };
    holdFor();
    const t = q.target || q;
    const msg = await walkTo(t.x, t.y, t.z);
    return { ok: true, msg };
  },
  'POST /follow': async (q) => {
    if (!bot) return { ok: false, msg: '还没上线' };
    holdFor();
    const p = bot.players[q.name];
    if (!p || !p.entity) return { ok: false, msg: `看不见 ${q.name}` };
    await walkTo(p.entity.position.x, p.entity.position.y, p.entity.position.z);
    return { ok: true, msg: `到了 ${q.name} 旁边` };
  },
  'POST /mine': async (q) => {
    holdFor();
    const msg = await mineBlock(q.block, q.count || 1);
    return { ok: true, msg };
  },
  'POST /craft': async (q) => {
    holdFor();
    const msg = await craftItem(q.item, q.count || 1);
    return { ok: true, msg };
  },
  'POST /place': async (q) => {
    holdFor();
    const msg = await placeBlock(q.block, q.x, q.y, q.z);
    return { ok: true, msg };
  },
  'POST /say': async (q) => {
    const msg = await say(q.text);
    return { ok: true, msg };
  },
  // 手动烧一炉，方便验证，也方便主人塞料
  'POST /smelt': async () => ({ ok: true, msg: await smeltSomething() }),
  'POST /attack': async (q) => {
    if (!bot || !bot.entity) return { ok: false, msg: '还没上线' };
    return await fight({ seconds: q.seconds || 20, radius: q.radius || 16, force: !!q.force });
  },
  'POST /eat': async () => {
    holdFor(8000);
    return { ok: true, msg: await eatFood(), state: state() };
  },
  'POST /defend': async (q) => {
    defend = q.on !== false && q.on !== 'false';
    return { ok: true, msg: defend ? '会自己还手了' : '不主动还手了' };
  },
  'GET /deeds': async () => {
    try {
      const all = fs.readFileSync(DEEDS, 'utf8').split('\n').filter(Boolean);
      return { ok: true, lines: all.slice(-12) };
    } catch (e) {
      return { ok: true, lines: [] };
    }
  },
  // 取走主人说的话（取一次就清空，避免她同一句话说两遍）
  'GET /inbox': async () => {
    const out = { ok: true, online: !!(bot && bot.entity), messages: inbox.slice(0, 10) };
    inbox = inbox.slice(out.messages.length);
    return out;
  },
  // 调试用：手动塞一句"主人说的话"，不用真的进游戏也能测她会不会回
  'POST /inbox': async (q) => {
    const text = String(q.text || '').slice(0, 200);
    if (!text) return { ok: false, msg: '空的' };
    inbox.push({ id: ++inboxSeq, from: OWNER, text, at: Date.now() });
    return { ok: true, msg: '塞进去了', count: inbox.length };
  },
  'POST /autoplay': async (q) => {
    if (!bot || !bot.entity) return { ok: false, msg: '还没上线' };
    if (auto.on) return { ok: false, msg: '已经在玩了' };
    const minutes = Math.max(1, Math.min(120, Number(q.minutes || 20)));
    auto = { on: true, until: Date.now() + minutes * 60000, hold: 0, task: '开始', done: [] };
    deed('自己玩', `自己上线玩，打算玩 ${minutes} 分钟`);
    autoLoop();
    return { ok: true, msg: `自己玩起来了，${minutes} 分钟` };
  },
  'POST /autostop': async () => {
    auto.on = false;
    return { ok: true, msg: '让她停了' };
  },
  'GET /auto': async () => ({
    on: auto.on,
    task: auto.task,
    left: auto.on ? Math.max(0, Math.round((auto.until - Date.now()) / 1000)) : 0,
    done: auto.done.slice(-10),
  }),
  'POST /record/start': async (q) => recordStart(q.tag || ''),
  'POST /record/stop': async () => recordStop(),
};

// ── 目标做完了就问她下一个 ───────────────────────────────
// 一晚上一个目标撑不住：砍完那棵树她就不知道干嘛，又回去抽奖了。
// 这里盯着完成条件，达成就记一笔、让她自己说一句，然后在后台跑 _ask_goal.py 换下一个。
let goalTrack = { key: '', base: 0, baseMade: 0, startedAt: 0, busy: false };

// 计划走完了就得接下一份。以前只有「按步推进」那条路会去问，
// 「跳步」和「跳过说不清的步」这两条把游标推到末尾就不管了，
// 结果 21:33 之后她退回了抽签，看起来像没目标。
let planDoneAsked = { key: '', at: 0 };

function ensureNextGoal() {
  const g = todayGoal();
  if (!g || !Array.isArray(g.steps) || !g.steps.length) return;
  if (Number(g.cursor || 0) < g.steps.length) return;
  const key = goalKeyOf(g);
  const now = Date.now();
  // 同一个问不出来的计划最多一分钟重试一次，避免刷屏
  if (planDoneAsked.key === key && now - planDoneAsked.at < 60000) return;
  planDoneAsked = { key, at: now };
  askNextGoal();
}

function goalKeyOf(g) {
  return g ? `${g.date}|${g.goal}` : '';
}

function askNextGoal() {
  if (goalTrack.busy) return;
  goalTrack.busy = true;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  let p;
  try {
    p = spawn(py, [path.join(__dirname, '..', '_ask_goal.py')],
      { cwd: __dirname, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    trace('目标', `问不下去：${e.message}`);
    goalTrack.busy = false;
    return;
  }
  p.on('exit', (code) => {
    _goalCache = { at: 0, data: null };
    goalTrack = { key: '', base: 0, baseMade: 0, startedAt: 0, busy: false };
    stepState = { index: -1, base: {} };
    trace('目标', code === 0 ? '问好了下一个目标' : `问目标失败 code=${code}`);
  });
}

// 这里只管两件事：记起始时间、一个计划拖太久就放弃。
// 正常推进靠 advanceStep——每做完一步就往前走一步，不由这里判断。
function checkGoalDone() {
  const g = todayGoal();
  if (!g || !bot || !bot.entity || goalTrack.busy) return;

  const key = goalKeyOf(g);
  if (goalTrack.key !== key) {
    goalTrack = { key, base: 0, baseMade: 0, startedAt: Date.now(), busy: false };
    return;
  }

  // 计划已经走完，等 askNextGoal 那边出结果，别在这儿反复问
  if (Array.isArray(g.steps) && g.steps.length
      && Number(g.cursor || 0) >= g.steps.length) return;

  const mins = Number(g.minutes || 40);
  if (Date.now() - goalTrack.startedAt > mins * 60000) {
    deed('计划', `${g.goal} 折腾了 ${mins} 分钟，先放着`);
    trace('目标', `超时 ${g.goal}`);
    askNextGoal();
  }
}

setInterval(checkGoalDone, 20000);

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const key = `${req.method} ${url}`;
  const handler = routes[key];
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!handler) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false, msg: `没有这个接口: ${key}` }));
  }
  try {
    const q = req.method === 'POST' ? await body(req) : {};
    const out = await handler(q);
    res.end(JSON.stringify(out === undefined ? { ok: true } : out, null, 0));
  } catch (e) {
    trace('异常', `${key} → ${e.message}`.slice(0, 140));
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, msg: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[her_mc] 听在 http://127.0.0.1:${PORT}`);
  trace('启动', '服务起来了');
});
