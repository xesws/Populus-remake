// convert-range-fx.ts — v0.26 转化技能范围圈
// 选中转化技能后，鼠标处显示半透明圆环：合法（距己方大祭司 ≤ CONVERT_CAST_RANGE）为
// 翠绿，非法为红灰；整体呼吸脉动，与 sculpt-indicator 同风格（贴地、depthWrite=false）。
import * as THREE from "three";
import { CONVERT_RADIUS } from "../types";

const BREATH_AMP = 0.05; // 呼吸幅度 ±5%
const BREATH_SPEED = 2.2;
const LIFT = 0.07;

const COL_OK = new THREE.Color("#5ce06a");
const COL_BAD = new THREE.Color("#d4543c");

export class ConvertRangeFX {
  group = new THREE.Group();

  private phase = 0;
  private mode: "cast" | "off" = "off";
  private ok = true;
  private ringMat = new THREE.MeshBasicMaterial({
    color: COL_OK,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private fillMat = new THREE.MeshBasicMaterial({
    color: COL_OK,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private ring: THREE.Mesh;
  private fill: THREE.Mesh;

  constructor() {
    this.ring = new THREE.Mesh(new THREE.RingGeometry(CONVERT_RADIUS - 0.06, CONVERT_RADIUS + 0.06, 64), this.ringMat);
    this.fill = new THREE.Mesh(new THREE.CircleGeometry(CONVERT_RADIUS - 0.15, 48), this.fillMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.fill.rotation.x = -Math.PI / 2;
    this.fill.position.y = LIFT - 0.01;
    this.ring.position.y = LIFT;
    this.group.add(this.fill, this.ring);
    this.group.visible = false;
  }

  setMode(mode: "cast" | "off", ok: boolean): void {
    this.mode = mode;
    this.ok = ok;
    this.group.visible = mode === "cast";
  }

  sync(x: number, z: number, groundY: number, dt: number): void {
    if (this.mode !== "cast") return;
    this.phase += dt;
    const breath = 1 + Math.sin(this.phase * BREATH_SPEED) * BREATH_AMP;
    this.ring.scale.set(breath, breath, 1);
    const col = this.ok ? COL_OK : COL_BAD;
    if (this.ringMat.color.getHex() !== col.getHex()) {
      this.ringMat.color.copy(col);
      this.fillMat.color.copy(col);
    }
    this.ringMat.opacity = this.ok ? 0.5 : 0.4;
    this.group.position.set(x, groundY + LIFT, z);
  }
}
