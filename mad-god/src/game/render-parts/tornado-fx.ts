import * as THREE from "three";
import type { Sim } from "../sim";

/**
 * v0.18 龙卷风渲染（Agent T）——细雾气条建模：
 * 主 agent 在 render.ts 挂载：`this.tornadoFx = new TornadoFX(); this.fxGroup.add(this.tornadoFx.group);`
 * 每帧调用 `this.tornadoFx.sync(sim, dt)`，替换原 syncTornado 的实体方块堆叠。
 *
 * 视觉：10 段半透明锥台由地面堆到约 4 格高，底部最细、顶部（云底）最宽，
 * 整组绕 Y 高速自旋，每段相位错开的摆动模拟扭曲下坠的雾气漏斗（从天而降）；
 * 水龙卷偏白蓝、正常灰白；剩余寿命不足 2s 时整体线性淡出（水龙卷后期同样走这条曲线）。
 */
export class TornadoFX {
  group = new THREE.Group();
  private built = false;
  private segs: THREE.Mesh[] = [];
  private segMats: THREE.MeshBasicMaterial[] = [];
  private cloudMat: THREE.MeshBasicMaterial | null = null;
  private spin = 0;
  private t = 0;

  sync(sim: Sim, dt: number): void {
    const tw = sim.tornado;
    if (!tw) {
      this.group.visible = false;
      return;
    }
    if (!this.built) this.build();
    this.t += dt;
    this.spin += dt * 6.5;

    const waterspout = (tw as { waterspout?: boolean }).waterspout === true;
    const color = waterspout ? 0xbcd8ea : 0xd6d2c8; // 水龙卷白蓝，正常灰白
    // 消散渐隐：剩余寿命不足 2s 线性淡出（t > life-2 的另一种写法）。
    const remain = tw.life - tw.t;
    const fade = Math.min(1, Math.max(0, remain / 2));
    const baseOp = waterspout ? 0.28 : 0.34;

    const h = sim.world.heightAt(tw.x, tw.z);
    this.group.position.set(tw.x, h, tw.z);
    this.group.rotation.y = this.spin;

    for (let i = 0; i < this.segs.length; i++) {
      const m = this.segs[i]!;
      const ph = this.t * 3.2 + i * 0.85; // 每段相位错开：整体旋转时呈扭曲雾条
      m.position.x = Math.sin(ph) * (0.05 + i * 0.018);
      m.position.z = Math.cos(ph * 1.3) * (0.05 + i * 0.018);
      m.rotation.x = Math.cos(ph * 1.1) * 0.06;
      m.rotation.z = Math.sin(ph * 0.9) * 0.06;
      const sc = 1 + Math.sin(ph * 0.7) * 0.06; // 轻微伸缩：雾气条呼吸感
      m.scale.y = sc;
      const mat = this.segMats[i]!;
      mat.color.setHex(color);
      mat.opacity = baseOp * fade;
    }
    if (this.cloudMat) {
      this.cloudMat.color.setHex(color);
      this.cloudMat.opacity = 0.16 * fade;
    }
    this.group.visible = true;
  }

  private build(): void {
    const N = 10; // 8~12 段范围内
    const segH = 0.42;
    const rBot = 0.13; // 底部（近地面）最细
    const rTop = 0.5; // 顶部（云底）最宽 → 细细一条从天而降的漏斗感
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const geo = new THREE.CylinderGeometry(
        rBot + (rTop - rBot) * Math.min(1, (i + 1) / (N - 1)),
        rBot + (rTop - rBot) * u,
        segH,
        9,
        1,
        true,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd6d2c8,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.y = segH / 2 + i * segH * 0.94; // 微叠层，接缝不露光
      this.group.add(m);
      this.segs.push(m);
      this.segMats.push(mat);
    }
    // 云底：漏斗顶端一块扁平圆盘，点出"龙卷风从天上降下来"。
    const cloudMat = new THREE.MeshBasicMaterial({
      color: 0xd6d2c8,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cloud = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.12, 12, 1, true), cloudMat);
    cloud.position.y = N * segH * 0.94;
    this.group.add(cloud);
    this.cloudMat = cloudMat;
    this.built = true;
  }
}
