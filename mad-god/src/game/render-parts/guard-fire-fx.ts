// v0.19 守卫篝火 fx：柴堆 + 跳动火焰锥 + 呼吸光点，按 sim.guardFires 同步显示（每队至多一处）。
// 沿用 v0.18 fx 模块模式：独立模块、render.ts 只做挂载，不侵入渲染主类。
import * as THREE from "three";
import type { SimClient } from "../client/sim-client";

export class GuardFireFX {
  group = new THREE.Group();
  private built = false;
  private mats: THREE.MeshBasicMaterial[] = [];
  private flames: THREE.Group[] = [];
  private glow: THREE.Mesh | null = null;
  private t = 0;

  sync(sim: SimClient, dt: number): void {
    if (!this.built) this.build();
    this.t += dt;
    const fires = sim.guardFires;
    // 子节点按序对应 sim.guardFires（每队一个，最多 2 个——复用前两个实例，多余的隐藏）。
    for (let i = 0; i < this.flames.length; i++) {
      const g = this.flames[i]!;
      const fire = fires[i];
      if (!fire) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      const h = sim.world.heightAt(fire.x, fire.z);
      g.position.set(fire.x, h, fire.z);
    }
    // 火焰跳动：三层错相缩放 + 轻微摇曳；光点呼吸。
    for (let k = 0; k < this.flames.length; k++) {
      const g = this.flames[k]!;
      if (!g.visible) continue;
      const layers = g.children;
      for (let i = 0; i < layers.length - 1; i++) {
        const m = layers[i] as THREE.Mesh;
        const ph = this.t * (5.2 + i * 1.4) + k * 2.3;
        const s = 1 + Math.sin(ph) * 0.18;
        m.scale.set(1 / s, s, 1 / s);
        m.rotation.y = Math.sin(ph * 0.6) * 0.16;
      }
    }
    if (this.glow) {
      const s = 1 + Math.sin(this.t * 2.4) * 0.22;
      this.glow.scale.set(s, s, s);
    }
  }

  private build(): void {
    for (let k = 0; k < 2; k++) {
      const g = new THREE.Group();
      // 柴堆：交叉的深棕小柱。
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a4128 });
      for (let i = 0; i < 4; i++) {
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.9, 5), woodMat);
        const a = (i / 4) * Math.PI;
        stick.position.set(Math.cos(a) * 0.16, 0.18, Math.sin(a) * 0.16);
        stick.rotation.z = Math.cos(a) * 0.7;
        stick.rotation.x = Math.sin(a) * 0.7;
        g.add(stick);
      }
      // 火焰：三层由大到小的半透明锥（内亮外暗）。
      const cols = [0xff5a1f, 0xff9e3d, 0xffd98a];
      const sizes = [0.34, 0.26, 0.17];
      for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: cols[i],
          transparent: true,
          opacity: 0.75 - i * 0.08,
          depthWrite: false,
        });
        this.mats.push(mat);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(sizes[i], 0.85 - i * 0.14, 6), mat);
        flame.position.y = 0.45 + i * 0.1;
        g.add(flame);
      }
      // 呼吸光点（火焰顶端的亮芯）。
      const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.9, depthWrite: false });
      this.mats.push(sparkMat);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), sparkMat);
      spark.position.y = 0.95;
      g.add(spark);
      if (k === 0) {
        // 地面光晕（仅第一处建，作为共享光源感）。
        const glowMat = new THREE.MeshBasicMaterial({ color: 0xff8c3a, transparent: true, opacity: 0.16, depthWrite: false });
        this.mats.push(glowMat);
        this.glow = new THREE.Mesh(new THREE.CircleGeometry(1.5, 18), glowMat);
        this.glow.rotation.x = -Math.PI / 2;
        this.glow.position.y = 0.05;
        g.add(this.glow);
      }
      g.visible = false;
      this.flames.push(g);
      this.group.add(g);
    }
    this.built = true;
  }
}
