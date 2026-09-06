import * as THREE from "three";
import type { SimClient } from "../client/sim-client";

/**
 * v0.30 大龙特效（render-parts 风格：独立 group + 每帧重建，数量级极小无需池化）：
 * - 火焰地块（DragonSystem 的 FirePatch）：地面橙色火簇，随剩余寿命收缩变暗；
 * - 吐息弹体：亮橙长条沿速度方向取向。
 */
export class DragonFX {
  group = new THREE.Group();

  private coreMat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
  private flameMat = new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.85 });
  private breathMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });

  sync(sim: SimClient, dt: number): void {
    void dt;
    while (this.group.children.length) {
      const ch = this.group.children[0]!;
      this.group.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
    for (const f of sim.fires) {
      const k = Math.max(0.12, f.life / f.maxLife);
      const h = sim.world.heightAt(f.x, f.z);
      const flame = (dx: number, dz: number, s: number, mat: THREE.Material) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.34 * s, 0.7 * s * k, 0.34 * s), mat);
        m.position.set(f.x + dx, h + 0.3 * s * k, f.z + dz);
        this.group.add(m);
      };
      flame(0, 0, 1.25, this.flameMat);
      flame(0.5, 0.3, 0.9, this.coreMat);
      flame(-0.45, -0.25, 0.85, this.flameMat);
      flame(0.15, -0.5, 0.7, this.coreMat);
      flame(-0.2, 0.45, 0.75, this.flameMat);
    }
    for (const p of sim.breaths) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.7), this.breathMat);
      m.position.set(p.x, p.y, p.z);
      const yaw = Math.atan2(p.vx, p.vz);
      m.rotation.y = yaw;
      m.rotation.x = -Math.atan2(p.vy, Math.hypot(p.vx, p.vz));
      this.group.add(m);
    }
  }
}
