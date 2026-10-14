export type ObstacleKind = 'rock' | 'pebble' | 'stick' | 'bump';

export interface ObstacleSpec {
  kind: ObstacleKind;
  x: number;
  z: number;
  /** collision radius on the ground plane */
  radius: number;
  /** stick length (0 for other kinds) */
  len: number;
  /** seeds the purely-visual shape distortion / rotation */
  shapeSeed: number;
}

export interface ArenaLayout {
  seed: number;
  seeds: [{ x: number; z: number }, { x: number; z: number }];
  obstacles: ObstacleSpec[];
}

export const ARENA_RADIUS: number;
export const WIN_SCORE: number;
export const MAX_LAUNCH_SPEED: number;
export function mulberry32(seed: number): () => number;
export function randomSeed(): number;
export function generateArena(seed: number): ArenaLayout;
