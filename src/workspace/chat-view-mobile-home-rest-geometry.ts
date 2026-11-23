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
  return (
    isNumberDisplaced(current.rootLeft, anchor.rootLeft) ||
    isNumberDisplaced(current.rootRight, anchor.rootRight) ||
    isNumberDisplaced(current.rootWidth, anchor.rootWidth) ||
    isNumberDisplaced(current.composerTop, anchor.composerTop) ||
    isNumberDisplaced(current.composerLeft, anchor.composerLeft) ||
    isNumberDisplaced(current.composerWidth, anchor.composerWidth) ||
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
