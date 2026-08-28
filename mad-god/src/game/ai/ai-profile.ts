// v0.17 敌方 AI 系统：难度配置类（schema 契约文件之一）。
// 全部 AI 节奏参数集中于此——调难度 = 换一个 AIProfile 实例，不改任何逻辑代码。
// 三档预设：easy（慢/小波/迟钝）、normal（当前强度基准）、hard（快/大波/激进）。

export class AIProfile {
  /** 决策周期（秒）：TribeBrain 每隔该时长思考一次 */
  tickSec = 1.0;
  /** 每座茅屋期望入住村民数（经济优先度；越高人口滚得越快） */
  occupyTarget = 2;
  /** 训兵最小间隔（秒） */
  trainGapSec = 8;
  /** 进攻波次最小兵力（士兵数达到才发波） */
  waveSize = 3;
  /** 两波进攻之间的冷却（秒） */
  waveGapSec = 60;
  /** 常备军上限（士兵总数超过则暂停训兵，把村民留给经济） */
  armyCap = 8;
  /** 被击反应延迟（秒）：部落防御响应的迟钝程度——难度核心人机差异 */
  reactSec = 1.5;
  /** 扩张野心 0~1：法力花在平地/开拓新宅基地的比例 */
  expandDrive = 0.5;
  /** 施法激进度 0~1：越高施法冷却越短、越敢砸大法术 */
  spellAggro = 0.6;

  static easy(): AIProfile {
    const p = new AIProfile();
    p.tickSec = 1.6;
    p.occupyTarget = 1;
    p.trainGapSec = 14;
    p.waveSize = 2;
    p.waveGapSec = 95;
    p.armyCap = 5;
    p.reactSec = 3.0;
    p.expandDrive = 0.3;
    p.spellAggro = 0.35;
    return p;
  }

  static normal(): AIProfile {
    return new AIProfile(); // 字段默认值即 normal 基准
  }

  static hard(): AIProfile {
    const p = new AIProfile();
    p.tickSec = 0.7;
    p.occupyTarget = 3;
    p.trainGapSec = 5;
    p.waveSize = 5;
    p.waveGapSec = 40;
    p.armyCap = 12;
    p.reactSec = 0.6;
    p.expandDrive = 0.75;
    p.spellAggro = 0.9;
    return p;
  }
}
