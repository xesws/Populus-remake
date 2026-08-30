// v0.29b SimClient：主线程侧对 Sim 的显式依赖面（纯类型，零运行时）。
// 本地模式 Game.sim 仍是真 Sim——结构化类型天然满足本接口；v0.29c 把 Sim 搬进
// Web Worker 后，主线程只持有实现 SimClient 的镜像客户端。主线程代码
// （game.ts / ui.ts / render.ts / render-parts / shot-director.ts / spells.ts 的入口）
// 只允许触碰这里列出的成员；sim 侧代码（sim.ts / systems/ / ai/ / spells/*）不受此限。
// 采用 Pick<Sim, K> 而非手写 interface：成员名与签名随 Sim 自动同步，杜绝两份声明
// 漂移（Sim 每版都在加字段）；可读性用按用途分组的注释弥补。
import type { Sim } from "../sim";

export type SimClient = Pick<
  Sim,
  // —— 世界与实体集合（本阶段仍是真引用，不做结构化镜像）——
  | "world"
  | "units"
  | "buildings"
  | "trees"
  | "shots"
  | "meteors"
  | "teams"
  // —— 对局状态 ——
  | "winner"
  | "time"
  | "logs"
  | "toastGen"
  | "armageddon"
  | "review"
  | "freezeProd"
  | "lockWin"
  // —— FX 回传（sim → 渲染的一次性事件/强度）——
  | "fxBolts"
  | "fxShake"
  | "fxQuake"
  | "fxVolcano"
  | "fxSplash"
  // —— 法术/灾害现场状态（渲染与拍摄导演读写）——
  | "swampKill"
  | "swampKillX"
  | "swampKillZ"
  | "blast"
  | "blastFlyer"
  | "stuckWatch"
  | "volcano"
  | "quake"
  | "tornado"
  | "tornadoLift"
  | "tornadoLiftX"
  | "tornadoLiftZ"
  | "tornadoHouse"
  | "guardFires"
  // —— 主循环 ——
  | "tick"
  // —— 提示与选择 ——
  | "toast"
  | "selectedOf"
  // —— 玩家指令 ——
  | "setOrder"
  | "setMagnet"
  | "sendMove"
  | "orderMove"
  | "orderAttackTarget"
  | "train"
  // —— 建造 ——
  | "canFound"
  | "foundSite"
  | "assignBuilders"
  | "tryPrepFound"
  | "placeComplete"
  | "markHouseBlocks"
  | "upgradeBuilding"
  // —— 查询 ——
  | "buildingAt"
  | "buildingById"
  | "buildingPad"
  | "unitAt"
  | "occupantAt"
  | "nearestTree"
  | "padEdge"
  | "padLocalToWorld"
  | "hutDoor"
  | "countPop"
  | "countHouses"
  | "countKind"
  | "countWood"
  | "trainSlotPos"
  | "trainQueue"
  // —— 技能充能 ——
  | "chargeState"
  | "hasCharge"
  | "fillCharges"
  // —— 拍摄导演专用（shot-director 摆拍/作弊）——
  | "addUnit"
  | "occupy"
  | "inSwamp"
  | "completeStep"
  | "crackPoint"
>;
