import { type CSSProperties } from 'react';
import './skeleton.css';

export type SkeletonVariant = 'text' | 'block' | 'circle';

export interface SkeletonProps {
  /** 形态变体：text 是单行文字占位，block 是矩形区块占位，circle 是圆形占位。默认 text。 */
  variant?: SkeletonVariant;
  /** 可选宽度，结构尺寸允许自由字符串（例如 '240px'、'60%'）。 */
  width?: string;
  /** 可选高度，结构尺寸允许自由字符串。 */
  height?: string;
}

/**
 * 骨架屏占位组件：--cb-skeleton 底色加呼吸式 opacity 动画（时长由 motion token 推导）。
 * 纯展示元素，对辅助技术隐藏。
 */
export function Skeleton({ variant = 'text', width, height }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) {
    style.width = width;
  }
  if (height !== undefined) {
    style.height = height;
  }
  return (
    <span className={`cb-skeleton cb-skeleton--${variant}`} style={style} aria-hidden="true" />
  );
}
