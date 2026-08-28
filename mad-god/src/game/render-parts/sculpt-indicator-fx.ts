// sculpt-indicator-fx.ts — v0.18 升降雕刻指示器
// 半透明圆形选框：双同心环 + 中心极淡填充盘，整体呼吸脉动（半径 3.0 ± 0.15），
// 环上叠一圈沿圆周流动的短弧段，形成"虚线流动"感。
// raise 暖橙（#ffb35c 系）/ lower 冷蓝（#5cb8ff 系）；材质一律半透明、depthWrite=false，
// 贴地渲染（y = 地形高 + 0.06）。名义半径与 SculptSpell 的雕刻半径 3.0 保持一致，
// 玩家看到的就是真实生效范围。
import * as THREE from "three";

const SCULPT_R = 3.0; // 名义半径：与 sculpt-spell.ts 的 SCULPT_RADIUS 一致
const BREATH_AMP = 0.05; // 呼吸幅度 ±5% → 半径 3.0 ± 0.15
const BREATH_SPEED = 2.2; // 呼吸角速度（rad/s）
const FLOW_SPEED = 1.1; // 弧段流动角速度（rad/s）
const ARC_COUNT = 8; // 弧段数量：8 段沿圆周均布，虚线观感
const ARC_LEN = 0.55; // 弧段沿圆周方向的长度
const ARC_WID = 0.07; // 弧段径向厚度
const LIFT = 0.06; // 离地高度：避免与地形 z-fight

const COL_RAISE = new THREE.Color("#ffb35c");
const COL_LOWER = new THREE.Color("#5cb8ff");

export class SculptIndicatorFX {
  /** 场景挂载根节点：主 agent 将它 add 进 scene，并每帧调用 sync() 驱动 */
  group = new THREE.Group();

  private mode: "raise" | "lower" | "off" = "off";
  private phase = 0; // 动画相位：呼吸与流动共用，静止时指示器也在动
  private ringMat = new THREE.MeshBasicMaterial({
    color: COL_RAISE,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private fillMat = new THREE.MeshBasicMaterial({
    color: COL_RAISE,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private arcMat = new THREE.MeshBasicMaterial({
    color: COL_RAISE,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private pulseGroup = new THREE.Group(); // 只缩放 x/z 呼吸，y 恒为 1，避免面板上下穿模
  private arcGroup = new THREE.Group();

  constructor() {
    // 双同心环：内环收口提示范围核心，外环就是"半径 3.0"的实际边界
    const innerRing = new THREE.Mesh(new THREE.RingGeometry(2.7, 2.86, 64), this.ringMat);
    const outerRing = new THREE.Mesh(new THREE.RingGeometry(2.94, 3.06, 64), this.ringMat);
    // 中心极淡填充盘：提示"将被影响的大致范围"，几乎透明只做底色
    const fill = new THREE.Mesh(new THREE.CircleGeometry(2.55, 48), this.fillMat);
    fill.renderOrder = 1; // 最后绘制，让填充盘叠在环下方更透气

    // 沿圆周均布 8 段短弧（小 Box 近似弧段）：Box 长轴沿圆周切线方向，
    // 本地 rotation.z = θ + π/2 使长轴旋转到切线；整个 arcGroup 绕垂直轴匀速
    // 旋转，即得"虚线沿圆周流动"的效果。
    for (let i = 0; i < ARC_COUNT; i++) {
      const theta = (i / ARC_COUNT) * Math.PI * 2;
      const arc = new THREE.Mesh(new THREE.BoxGeometry(ARC_LEN, ARC_WID, 0.02), this.arcMat);
      arc.position.set(Math.cos(theta) * SCULPT_R, Math.sin(theta) * SCULPT_R, 0);
      arc.rotation.z = theta + Math.PI / 2;
      this.arcGroup.add(arc);
    }

    this.pulseGroup.add(fill, innerRing, outerRing, this.arcGroup);
    // 整个面板放平到地面：本地 XY 平面 → 世界 XZ 平面（render.ts 的 selectRing 同款手法）
    this.pulseGroup.rotation.x = -Math.PI / 2;
    this.group.add(this.pulseGroup);
    this.group.visible = false;
  }

  /** 切换指示器状态：raise 暖橙 / lower 冷蓝 / off 隐藏 */
  setMode(mode: "raise" | "lower" | "off"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "off") {
      this.group.visible = false;
      return;
    }
    const col = mode === "raise" ? COL_RAISE : COL_LOWER;
    this.ringMat.color.copy(col);
    this.arcMat.color.copy(col);
    this.fillMat.color.copy(col);
    this.group.visible = true;
  }

  /**
   * 每帧驱动：跟随光标位置贴地（h + 0.06），并推进呼吸/流动动画相位。
   * 呼吸通过 pulseGroup 的 x/z 缩放实现（y 恒为 1，面板不会上下穿模）。
   */
  sync(x: number, z: number, h: number, dt: number): void {
    if (this.mode === "off") return;
    this.phase += dt;
    const s = 1 + BREATH_AMP * Math.sin(this.phase * BREATH_SPEED);
    this.pulseGroup.scale.set(s, 1, s);
    this.arcGroup.rotation.z = this.phase * FLOW_SPEED;
    this.group.position.set(x, h + LIFT, z);
  }
}
