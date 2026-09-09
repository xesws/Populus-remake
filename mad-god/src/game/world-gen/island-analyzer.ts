// v0.36 岛屿分析器：纯读高度场，按给定水位做 4 邻接 BFS，输出权威标签与几何统计。
// WorldGen 的原始岛形与 World 的终局岛表都复用这一口径，避免各阶段各写一套连通定义。

export interface AnalyzedIsland {
  label: number;
  cells: number;
  cx: number;
  cz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface IslandTopology {
  grid: Int32Array;
  sizes: number[];
  islands: AnalyzedIsland[];
  largestLabel: number;
}

export class IslandAnalyzer {
  static analyze(heights: Float32Array, samples: number, step: number, water: number): IslandTopology {
    const n = heights.length;
    const grid = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const sizes: number[] = [];
    const islands: AnalyzedIsland[] = [];
    let largestLabel = -1;
    let largestSize = 0;
    let label = 0;

    for (let seed = 0; seed < n; seed++) {
      if (grid[seed] !== -1 || heights[seed]! <= water) continue;
      let head = 0;
      let tail = 0;
      let sx = 0;
      let sz = 0;
      let minIx = samples;
      let maxIx = -1;
      let minIz = samples;
      let maxIz = -1;
      queue[tail++] = seed;
      grid[seed] = label;
      const push = (index: number): void => {
        if (grid[index] !== -1 || heights[index]! <= water) return;
        grid[index] = label;
        queue[tail++] = index;
      };
      while (head < tail) {
        const cur = queue[head++]!;
        const iz = (cur / samples) | 0;
        const ix = cur - iz * samples;
        sx += ix;
        sz += iz;
        if (ix < minIx) minIx = ix;
        if (ix > maxIx) maxIx = ix;
        if (iz < minIz) minIz = iz;
        if (iz > maxIz) maxIz = iz;
        if (ix > 0) push(cur - 1);
        if (ix < samples - 1) push(cur + 1);
        if (iz > 0) push(cur - samples);
        if (iz < samples - 1) push(cur + samples);
      }
      sizes[label] = tail;
      islands.push({
        label,
        cells: tail,
        cx: (sx / tail) * step,
        cz: (sz / tail) * step,
        minX: minIx * step,
        maxX: maxIx * step,
        minZ: minIz * step,
        maxZ: maxIz * step,
      });
      if (tail > largestSize) {
        largestSize = tail;
        largestLabel = label;
      }
      label++;
    }
    islands.sort((a, b) => b.cells - a.cells || a.label - b.label);
    return { grid, sizes, islands, largestLabel };
  }
}
