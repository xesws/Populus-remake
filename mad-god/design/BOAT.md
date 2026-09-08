# 神也疯狂 · 船屋 + 战船（两栖载具）

参照《开天辟地》的船：小木船摆渡子民过海，火战士站船头照样开火，船沉人亡。
稿 `BOAT.md`。选人/右键口径照 `INTERACT.md`，生产口径照 `PRODUCTION.md`，数值集中在 `types.ts` 的船常量区。

一句话：船屋住满 10 人下水饺，6 人一条船，船沉人亡，v1 只给玩家开（红方不用船）。

## 数值（全部在 `types.ts`，改参不动逻辑）

| 项 | 值 | 备注 |
|---|---|---|
| 载员 | 6 | `BOAT_CAPACITY`，第 7 人拒绝上船 |
| 船血量 | 150 | ≈ 2× L3 茅屋，火球/法术可击沉 |
| 船速 | 4.0 | 村民 2.6，水上快车 |
| 上船半径 | 2.5 | 人↔船；且船 2.5 内必须有可走岸（`BOAT_DOCK_RANGE`），否则红叉 |
| 吃水 | h ≤ WATER | 与海水染色同一口径，可进滩涂（0.16 滩照样开，视觉上微搁浅，停靠就靠它） |
| 沉没动画 | 2.0s | `SINK_T`：船体下沉+倾斜，白色涟漪扩散环 1.2s |
| 船屋木料 | 4 | 与训练营同档 |
| 船屋住户 | 10 | `BOATHOUSE_DWELL`，住满才开工（`produce` 分支） |
| 造船节拍 | ~25s/条 | 住满后速率，具体走 `houseBaseRate` 同量级，调参只动常量 |
| 同屋存活上限 | 3 | `producedBoatIds`（`produced_units` 语义），沉一补一 |
| 船屋占地 | 2.6×2.6 | 训练营尺寸；单级，无升级 |
| 船屋选址 | 陆地 pad + 7 格内有水 | `BOATHOUSE_WATER_RANGE`，否则拒绝落基＋toast"船屋必须建在岸边" |
| 下水半径 | 6 | `LAUNCH_RANGE`，屋旁找水下水，找不到则进度保留等待 |

## 实体与归属（OOP 单点归属）

- `Boat extends Unit`（`entities/units/boat.ts`），`UnitKind` 尾部追加 `"boat"`（`UNIT_KINDS` 跨端序号规则：只许 push 尾部，v0.30 大龙先例）。
- `Boathouse extends Building`（`entities/buildings/boathouse.ts`），`BuildingKind` 追加 `"boathouse"`；`factory.ts` 两工厂各加一个 case；`BUILDING_PROTOS`（codec 镜像构造）加一条；`sitePad`/`woodNeedFor` 登记 2.6/4 木。
- **`BoatSystem`**（`systems/boat-system.ts`，注册进 `systems/index`＋`sim.tick`）：上下船、下水、沉没、船员坐标同步、水上路径驱动，全部归它。战斗只加一个通道（见下），不碰主循环。
- 船员挂船 = `homeId = boat.id`（哨塔驻军同款语义）：不可点选（`unitAt` 本来就跳 `homeId>0`）、不吃入住/训练/建工指派（occupy/train/assignBuilders 全是 `homeId===0` 口径，天然免疫）、小地图默认不画（`drawMini` 同口径）。

## 上船（右键自家船）

1. 选中陆地单位（walker/warrior/preacher/firewarrior/spy/shaman，`isTribe` 且 `homeId===0`，龙除外）右键**自家**船 → `game.secondary` 先于攻击/移动分支进上船分支。
2. 合法条件：人↔船 ≤2.5、船员未满 6、船 2.5 内有可走岸。人先走到船边最近可走岸点（复用 `padEdge`＋`astar`），到站自动上船（复用 `tryOccupy` 的"targetId＋到站"模式：`targetId = boat.id`，到站判定进 `thinkUnits`，**不新增字段**）。
3. 上船瞬间：`homeId = boat.id`、`job = "idle"`、`think = 99`（冻住陆地 AI，与住户同规）、`path/targetId/atkId` 清零、移出选中集。右键敌船 = 照常进攻（`closestRed` 本来就捡 `homeId===0` 的单位，船是单位，开火链路零改动）。
4. 光标：选中陆地单位悬停自家船 → 可上船给 `board`（青环），船离岸太远/满员给 `deny`（红环＋红叉，见"光标"节）。

## 航行（水域 A*）

- `path.ts` 新增 `waterAstar`：与 `astar` 同构，可走判据换成"吃水"（`h ≤ WATER`），浅滩可进、陆地禁入。群岛水道可绕行；孤立水洼/四面陆地围死 → 无路，船停岸边＋toast。
- 选中自家船右键水面 → `waterAstar` 算路写进 `u.path`，复用既有跟随器；`PathSystem.moveUnits` 加船分支（仿 `isFlying` 先例）：按 `BOAT_SPEED` 走、不做地面吸附（`u.y > g0+0.02 → u.y = g0` 那行会把船拍进海床，必须跳过）、y 钉在吃水线 `WATER + 0.15`。
- 选中船右键陆地/岸 → **全员下船**（见下），不是开上岸；船自己永远不上岸。
- 选中船右键敌人 → 船无武器，不开火，只做"靠近移动"（approach），靠船上火战士进射程后默认索敌开火。右键空水面 = 航行。
- 船只间：同队小圆分离（避重叠），与陆地单位无碰撞（不同层）。

## 下船（船靠岸＋右键岸）

1. 船在 `BOAT_DOCK_RANGE` 内有可走岸时，悬停岸边光标变 `disembark`（绿环）；右键岸 → 全员下船。
2. 落点：船边最近可走岸点周围螺旋找 6 个可走格（`spawnNear` 同款手法），船员逐个落定：`homeId = 0`、`think = 0`、`job = "idle"`，**恢复自由可选**（spec 原话）。
3. 下船后的单位就是普通自由单位：可被选中、可入住、可被指派，一切默认。

## 船上开火（CombatSystem 加一个通道，仿 towerCombat）

- 主循环全跳 `homeId>0`（6 处既有过滤），船员在主循环里天然开不了火——**这正是哨塔驻军走 `towerCombat` 独立通道的原因**，照抄：`boatCombat(sim, dt)`，船员按默认武器参数从船位索敌开火（射程/间隔/伤害全部默认，spec 原话"保持默认行为即可"）。
- 对称地，敌人也索敌不到船员（`o.homeId > 0 → continue` 六处全覆盖）：伤害全吃船身，船沉才死人，spec 语义天然成立。
- `canConvert("boat") = false`（types 表加一项）：传教士不许感化一条船。

## 击沉（血条＋2s 沉没＋团灭）

- 船就是一条会动的"建筑单位"（spec 原话）：火战士火球、单体法术（火球/闪电/天罚）走单位通道默认命中；`damageArea` 的单位循环默认覆盖（闪电/爆裂/陨石 AoE）；龙息压到船按单位半径结算（实现时 verify 一把）。
- 天生打不到船的：火山岩浆（`pourLava`/`flowLava` 跳 `h ≤ WATER` 格，水面无浆——火山只能烧岸，不能烧船，合理）；地震裂缝（`slideIntoCracks` 加两行守卫：跳过 `kind === "boat"` 与 `homeId > 0`—— vessels 免裂缝，有房住的共享建筑命运， principled）；龙卷风（船太重，`tickTornado` 跳过船，备注一行）。
- `hp ≤ 0` → `sinkT = SINK_T`（`Unit` 加一个数栏，默认 0）：立即 `selected = false`＋`path = []` 锁控；`cull` 加一行守卫（`sinkT > 0` 的沉船本轮不删）；`BoatSystem.tick` 递减；到 0 时船员 `hp = 0`（spec 原话"沉没后上面的单位全部阵亡"），船下帧被 `cull` 正常带走。
- 表现：开沉瞬间刷白色涟漪扩散环（复用 blast 环 mesh 基础设施，白料、1.2s 放大＋淡出）；`syncUnits` 船分支读 `sinkT` 做下沉＋倾斜；toast"战船沉没"。沉船不留残骸（与现单位一致）。

## 船屋生产（ProductionSystem 加一个分支，仿茅屋）

- `occupy` 放行船屋：walker、`level ≥ 1`、`dwell < 10`（`houseMaxPop` 旁另起 `BOATHOUSE_DWELL`，不进升级链；船屋单级，`wantLevel` 永不用）。
- `produce` 船屋分支：`level ≥ 1 && dwell ≥ 10` 才涨进度（spec 原话"住满 10 个村民之后才能开始生产"），`freezeProd` 同规暂停；`prod ≥ 1` 时先懒清理 `producedBoatIds`（`unitById` 存活校验），存活 < 3 才下水：屋旁 `LAUNCH_RANGE` 内找水格（朝水方向螺旋，找不到则**进度保留等待**，仿满员待产口径，不弹 toast 刷屏，记 periodic 日志）；下水 `addUnit(BLUE/RED, "boat", …)`＋`producedBoatIds.push`＋`prod = 0`＋toast"战船下水"。存活已满 3 → 进度保留，下次 tick 重试（沉一补一，spec 原话）。
- `refreshHouses` 船屋分支：走哨塔同款（`padStats` 陆地比＋均值），水没了只影响下水（生产等待），不拆屋。
- 船不占人口上限：`countPop` 跳过 `kind === "boat"`（否则每条船卡一个村民出生位；红方无船，AI 侧无感）。`checkWin` 实现时 audit 一把（船 hp>0 算存活，船员随船走，预期默认即对）。

## 选址与建造（Q3-A：必须岸边）

- `canFound` 加船屋专条：pad 为陆地（走既有 `padReady`）**且** `BOATHOUSE_WATER_RANGE` 内有水格，否则 `false`；玩家放置流（`placeKind = "boathouse"` → 幽灵 → 点选 → 村民前往 → `foundSite`）走训练营同链路，拒绝时 toast"船屋必须建在岸边"（落点走既有非法放置提示口）。
- `tryPrepFound`/`foundSite`/`upgradeBuilding` 占地口径统一 `sitePad("boathouse")`（v0.28c 教训：预备/校验/落基同一口径）。
- 渲染朝向（可选小甜点）：落基时 yaw 自动朝最近水面，省得码头背对大海；玩家 R 键仍可手动转。

## 光标（View.hover 加 4 态，与 fightRing＋fist 同构）

| 态 | 颜色 | 触发 |
|---|---|---|
| `board` | 青环 | 选中陆地单位，悬停**自家**船且可上船 |
| `deny` | 红环＋红叉 | 同上但不可上船（满员/离岸太远） |
| `sail` | 浅蓝环 | 选中自家船，悬停水面 |
| `disembark` | 绿环 | 选中自家船且可停靠，悬停岸 |
| 回退 | 既有 move/fight/off | 其余一切 |

判定入口 `boatCursorFor(x, z, selected)` 放 `game.ts`（`hover` 调用点旁边），CSS 十字光标不动，语义全由 3D 环承载（不引入贴图资源）。

## 渲染与 UI 增量

- 船体：`box()` 低多边形拼（船壳＋舷＋队色饰条），船员站甲板 6 槽位（2×3，`arrangeDwellers` 船分支或 `BoatSystem.tick` 摆位，y＝甲板线；v1 站着，坐姿以后再说）。
- 船屋：茅屋变体＋高脚＋朝水一侧小码头 plank（静态 mesh）。
- HUD：`index.html` 加 `data-build="boathouse"` 按钮＋ico；`pickLabel` 加"选中战船/选中船屋"；`syncProdBars` 覆盖船屋生产条（无进驻条，船屋不住兵只住村民）。
- 小地图：船画点（单位通道默认），船员不画（`homeId` 口径默认）。

## 法术交互矩阵（默认即所得，实现时逐项 verify）

| 法术 | 对船 | 对船员 | 备注 |
|---|---|---|---|
| 火球/闪电/天罚单体 | ✔ 直接命中 | ✘ 索敌不到 | 船是单位，默认 |
| 闪电/爆裂/陨石 AoE | ✔ `damageArea` 单位循环 | ✘ | 默认 |
| 火山 | ✘（水面无浆） | ✘ | 物理自洽，无需改 |
| 地震 | ✘（加守卫） | ✘（加守卫） | 唯二要加代码的豁免 |
| 龙卷风 | ✘（太重，跳过） | ✘ | 加一行守卫 |
| 龙息 | ✔（verify） | ✘ | 半径结算，默认即对 |
| 沼泽 | ✘（水面不长沼泽，`SwampSpell` 既有拒绝） | ✘ | 默认 |
| 感化 | ✘（`canConvert` 加表） | ✘ | 加一项表 |

## 同步（worker 模式零改动设计）

- `UNIT_KINDS` 尾部 push `"boat"` 即可；船员关系走既有 `homeId` 槽位（UF 22，主线程读面本来就有，`syncUnits`/`drawMini` 全复用）。
- `sinkT` 不进快照：镜像端用"hp≤0 且仍在场＝正在沉"推导沉没动画，无需扩 `UF_N`（不断 `worker-codec-check` 的布局锁）。
- `BUILDING_PROTOS` 加 `"boathouse"` 空原型（镜像只读不产，`producedBoatIds` 不同步）。

## AI 范围（Q2-A：v1 红方不用船）

- Economy/War/Spell 三子脑**零改动**；实现时 audit 一圈 kind 过滤（`assignHomes` 只认 hut、波次 `isFighter` 不含船、敌方船屋进 WarDirector 目标池当普通建筑打——都是期望行为）。
- 海战 AI（渡海登陆/两栖防守/红方造船）另立项，不在本稿。

## 测试清单（实现阶段新 `boat-check.ts`，逐条断言）

1. 上船：6 人满员，第 7 人拒绝；船员 `homeId` 挂船、不可点选、随船同坐标移动。
2. 红叉：船离岸超 `DOCK_RANGE` → `deny`，右键无事发生（不冻住、不误走）。
3. 航行：只走水，陆岬绕行；孤立水洼无路 → 停岸＋toast。
4. 下船：靠岸右键岸 → 6 人落可走格，全部恢复选中/入住/指派。
5. 开火：船上火战士自动射程内敌人（`boatCombat` 通道），伤害数字与陆地一致。
6. 击沉：`damageArea` 灌死 → 2s 沉没 → 船员全灭 → `producedBoatIds` 减员 → 船屋补产。
7. 船屋：9 人不产，10 人开产；3 条存活时进度保留不爆产；无水下水点时等待不崩。
8. 感化/地震/龙卷三豁免；`countPop` 不含船；codec 来回 kind＋homeId 不丢。

## v1 不做

红方造船用船；船撞船；船只修理；船屋升级；船员坐姿动画；鲨鱼（没有鲨鱼）。
