import * as THREE from "three";
import type { Sim } from "../sim";
import type { World } from "../world";
import { SAMPLES, STEP } from "../types";

/**
 * v0.18 火山 FX（Agent V 交付，独立模块，不碰 render.ts）：
 *
 * 两组粒子（对象池 ≤120 个小 Box mesh）：
 *   a) 喷发弹跳粒子：sim.volcano 存在且 t<dur+1 时从火山口喷出，重力下落，落地消失；
 *   b) 岩浆流粒子：扫描 world.lava 活跃格，粒子沿地形梯度下坡方向缓慢流动（四方向 heightAt 求梯度），
 *      颜色随 life 从亮橙冷却到暗红（5 档共享材质），半透明贴地。
 *
 * 焦土配色建议（供主 agent 在 render.ts heightColor 采用）：
 *   现有 COL_SCORCH #3a2a1c 偏黑炭。建议灰褐系按 scorch 强度插值：
 *   - 浅焦土（scorch 刚干，~2.2）：#6a5745 (106,87,69)
 *   - 中焦土（scorch 中段，~1.3）：#57463a (87,70,58)
 *   - 深焦土（scorch 将消，~0.5）：#3a2e24 (58,46,36)
 *   比纯黑更有"烧过的灰褐地面"质感，也与 lava 亮橙形成冷暖对比。
 *
 * 挂载（主 agent 集成）：
 *   const lavaFX = new LavaFX();
 *   view.scene.add(lavaFX.group);          // 与 fxGroup 同级
 *   view.sync()/draw 内：lavaFX.sync(sim, dt);
 *   view.resetFx()/restart 时：lavaFX.reset();
 */

const MAX_PARTICLES = 220;

// 粒子配色档：亮橙 → 橙 → 暗橙 → 红 → 暗红（随 life 冷却换档）。
const STREAM_COLS = [0xffb347, 0xff8c2a, 0xff6a1a, 0xd84315, 0x8a2e10] as const;
const ERUPT_COLS = [0xffcf6a, 0xff9a3c, 0xff7a18, 0xd84315, 0x8a2e10] as const;

interface LavaParticle {
  mesh: THREE.Mesh;
  active: boolean;
  kind: 0 | 1; // 0=喷发弹跳 1=岩浆流
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  speed: number;
  spinX: number;
  spinZ: number;
  /** v0.21 喷发粒子剩余弹跳次数：落地反弹一次再熄灭——"四溅"的关键。 */
  bounce: number;
}

export class LavaFX {
  group = new THREE.Group();

  private pool: LavaParticle[] = [];
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private streamMats: THREE.MeshLambertMaterial[] = [];
  private eruptMats: THREE.MeshLambertMaterial[] = [];

  constructor() {
    for (const c of STREAM_COLS) {
      this.streamMats.push(
        new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.55, transparent: true, opacity: 0.82 }),
      );
    }
    for (const c of ERUPT_COLS) {
      this.eruptMats.push(
        new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.7 }),
      );
    }
  }

  sync(sim: Sim, dt: number): void {
    const w = sim.world;
    this.tickParticles(w, dt);
    const v = sim.volcano;
    if (v && v.t < v.dur + 1) {
      // v0.21 炸裂喷发：初喷 1.2s 是爆发窗口——3 倍密度、冲天速度、大块岩浆团四散；
      // 主喷期持续猛喷。喷口位置与 spell 的方向分布同款采样（扇区侧喷得更多）。
      const h = w.heightAt(v.x, v.z);
      const burst = v.t < 1.2;
      let n = Math.ceil((burst ? 66 : 30) * dt);
      while (n-- > 0) this.spawnErupt(v.x, v.z, h, burst, v.biasPhi, v.biasWidth);
    }
    this.scanLava(w, dt);
  }

  /** 主 agent restart / resetFx 时调用：回收全部粒子。 */
  reset(): void {
    for (const p of this.pool) this.kill(p);
  }

  private tickParticles(w: World, dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.kill(p);
        continue;
      }
      if (p.kind === 0) {
        // 喷发粒子：重力下落，落地弹跳一次（反弹衰减），第二次落地才熄灭——四溅感。
        p.vy -= 9.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const ground = w.heightAt(p.x, p.z) + 0.02;
        if (p.y <= ground && p.vy < 0) {
          if (p.bounce > 0) {
            p.bounce -= 1;
            p.y = ground;
            p.vy = -p.vy * 0.38;
            p.vx *= 0.62;
            p.vz *= 0.62;
          } else {
            this.kill(p);
            continue;
          }
        }
        p.mesh.rotation.x += p.spinX * dt;
        p.mesh.rotation.z += p.spinZ * dt;
      } else {
        // 岩浆流粒子：沿地形梯度下坡方向流动（高度场四方向差分），贴地，随 life 冷却变色。
        const hL = w.heightAt(p.x - 0.3, p.z);
        const hR = w.heightAt(p.x + 0.3, p.z);
        const hD = w.heightAt(p.x, p.z - 0.3);
        const hU = w.heightAt(p.x, p.z + 0.3);
        const gl = Math.hypot(hR - hL, hU - hD);
        if (gl > 1e-4) {
          p.vx = (p.speed * (hL - hR)) / gl;
          p.vz = (p.speed * (hD - hU)) / gl;
        }
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        // v0.21 翻腾：厚浆区粒子上下沸腾跳动（相位按个体错开），不再平贴滑行。
        const boil = Math.sin(p.life * 9 + p.x * 3.1 + p.z * 2.7) * 0.09;
        p.y = w.heightAt(p.x, p.z) + 0.05 + Math.max(0, boil);
        const t = 1 - p.life / p.maxLife;
        const idx = Math.min(4, Math.floor(t * 5));
        if (p.mesh.material !== this.streamMats[idx]) p.mesh.material = this.streamMats[idx]!;
      }
      p.mesh.position.set(p.x, p.y, p.z);
    }
  }

  /** v0.18 扫描 lava 活跃格（全扫，步长 1 不漏细支流），按余量概率发射岩浆流粒子。 */
  private scanLava(w: World, dt: number): void {
    const lava = w.lava;
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const lv = lava[iz * SAMPLES + ix]!;
        if (lv <= 0) continue;
        // 发射率随 lava 余量：越厚越活跃（v0.21 提到 0.16，翻腾更密）；厚浆区粒子更大更快。
        if (Math.random() < 0.16 * dt * Math.min(1.8, lv / 5)) {
          this.spawnStream(w, ix * STEP, iz * STEP, lv);
        }
      }
    }
  }

  private spawnErupt(
    x: number,
    baseY: number,
    z: number,
    burst: boolean,
    biasPhi: number,
    biasWidth: number,
  ): void {
    const p = this.getFree();
    if (!p) return;
    p.kind = 0;
    p.x = x + (Math.random() - 0.5) * 0.9;
    p.z = z + (Math.random() - 0.5) * 0.9;
    p.y = baseY + 0.25 + Math.random() * 0.5;
    // v0.22 方向分布：粒子水平初速朝喷射偏置方向（扇区侧飞得更多）。
    const spread = biasWidth >= Math.PI * 2 - 1e-3 ? Math.PI : biasWidth * 0.5;
    const g = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const ang = biasPhi + g * spread;
    const hSpeed = burst ? 3.5 + Math.random() * 4.5 : 2 + Math.random() * 2;
    if (burst) {
      // v0.21 初喷爆发：冲天 6~11、四散、寿命更长——像炸开一样轰出去。
      p.vx = Math.cos(ang) * hSpeed;
      p.vy = 6 + Math.random() * 5;
      p.vz = Math.sin(ang) * hSpeed;
      p.life = 1.5 + Math.random() * 1.1;
    } else {
      // 主喷期：持续猛喷。
      p.vx = Math.cos(ang) * hSpeed;
      p.vy = 4 + Math.random() * 4;
      p.vz = Math.sin(ang) * hSpeed;
      p.life = 1.1 + Math.random() * 0.9;
    }
    p.maxLife = p.life;
    p.speed = 0;
    p.spinX = (Math.random() - 0.5) * 12;
    p.spinZ = (Math.random() - 0.5) * 12;
    p.bounce = 1;
    p.mesh.material = this.eruptMats[Math.floor(Math.random() * this.eruptMats.length)]!;
    // v0.21 大小混合：大块岩浆团与小火星混杂，大块更醒目。
    const big = Math.random() < 0.3;
    const s = big ? 0.26 + Math.random() * 0.22 : 0.1 + Math.random() * 0.1;
    p.mesh.scale.set(s, s, s);
    p.mesh.rotation.set(0, 0, 0);
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.set(p.x, p.y, p.z);
  }

  private spawnStream(w: World, x: number, z: number, lavaAmt: number): void {
    const p = this.getFree();
    if (!p) return;
    p.kind = 1;
    p.x = x;
    p.z = z;
    p.y = w.heightAt(x, z) + 0.05;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.life = 1.6 + Math.random() * 1.0;
    p.maxLife = p.life;
    // 余量越厚流得越快（0.5~2 格/秒级别），配合梯度方向形成"顺坡流下"。
    p.speed = 1.05 + Math.min(0.8, lavaAmt * 0.08) + Math.random() * 0.35;
    p.spinX = 0;
    p.spinZ = 0;
    p.mesh.material = this.streamMats[0]!;
    p.mesh.scale.set(0.13, 0.06, 0.13);
    p.mesh.rotation.set(0, 0, 0);
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.set(p.x, p.y, p.z);
  }

  private getFree(): LavaParticle | null {
    for (const p of this.pool) {
      if (!p.active) return p;
    }
    if (this.pool.length >= MAX_PARTICLES) return null;
    const mesh = new THREE.Mesh(this.boxGeo, this.streamMats[0]!);
    mesh.visible = false;
    this.group.add(mesh);
    const p: LavaParticle = {
      mesh,
      active: false,
      kind: 1,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      maxLife: 1,
      speed: 1,
      spinX: 0,
      spinZ: 0,
      bounce: 0,
    };
    this.pool.push(p);
    return p;
  }

  private kill(p: LavaParticle): void {
    p.active = false;
    p.mesh.visible = false;
  }
}
