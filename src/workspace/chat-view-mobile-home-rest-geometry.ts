export interface MobileHomeRestGeometry {
  rootLeft: number;
  rootRight: number;
  rootWidth: number;
  composerTop: number;
  composerLeft: number;
  composerWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  visualViewportHeight: number | null;
  visualViewportOffsetTop: number | null;
}

const MOBILE_HOME_REST_GEOMETRY_TOLERANCE_PX = 1;

function isNumberDisplaced(left: number, right: number): boolean {
  return (
    Math.abs(left - right) >
    MOBILE_HOME_REST_GEOMETRY_TOLERANCE_PX
  );
}

function isOptionalNumberDisplaced(
  left: number | null,
  right: number | null
): boolean {
  if (left === null || right === null) {
    return left !== right;
  }
  return isNumberDisplaced(left, right);
}

export function isMobileHomeRestGeometryDisplaced(
  anchor: MobileHomeRestGeometry,
  current: MobileHomeRestGeometry
): boolean {
  // 横向位移只认左缘/槽位左缘的平移：侧栏 drawer 会整体平移 workspace；而键盘期
  // 纵向滚动条的出现/消失只改变右缘与宽度（安卓 1.15.0 实测 5px，左缘不动），
  // 若把宽度也算位移，锚点会永远“被顶住”，主页位置 writer 再也不写。
  return (
    isNumberDisplaced(current.rootLeft, anchor.rootLeft) ||
    isNumberDisplaced(current.composerTop, anchor.composerTop) ||
    isNumberDisplaced(current.composerLeft, anchor.composerLeft) ||
    isNumberDisplaced(current.viewportHeight, anchor.viewportHeight) ||
    isOptionalNumberDisplaced(
      current.visualViewportHeight,
      anchor.visualViewportHeight
    ) ||
    isOptionalNumberDisplaced(
      current.visualViewportOffsetTop,
      anchor.visualViewportOffsetTop
    )
  );
}
