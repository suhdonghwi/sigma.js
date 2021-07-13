/**
 * Sigma.js Labels Heuristics
 * ===========================
 *
 * Miscelleneous heuristics related to label display.
 * @module
 */
import Graph from "graphology";
import { EdgeKey, NodeKey } from "graphology-types";
import { Dimensions, Coordinates, CameraState } from "../types";
import Camera from "./camera";

// TODO: it could be useful to reinstate a heuristic always keeping the biggest node's label shown
// TODO: switch to a label density setting (with automagic reset of grid state)
// TODO: maybe computing the grid for all the plane, and not the frame, even when zoomed, can avoid silly panning weirdness
// TODO: maybe we don't need to convert selected labels to an array ever?

/**
 * Constants.
 */

// Dimensions of a normal cell
const DEFAULT_CELL = {
  width: 250,
  height: 175,
};

// Dimensions of an unzoomed cell. This one is usually larger than the normal
// one to account for the fact that labels will more likely collide.
const DEFAULT_UNZOOMED_CELL = {
  width: 400,
  height: 300,
};

const DEFAULT_MAX_DENSITY = 0.3 / 100 / 100;

/**
 * Helpers.
 */
export function axisAlignedRectangularCollision(
  x1: number,
  y1: number,
  w1: number,
  h1: number,
  x2: number,
  y2: number,
  w2: number,
  h2: number,
): boolean {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}

/**
 * Classes.
 */

/**
 * Class representing a camera movement from two subsequent states.
 *
 * @todo possibility to move this elsewhere if useful
 */
class CameraMove {
  isZooming: boolean;
  isUnzooming: boolean;
  hasSameRatio: boolean;
  isPanning: boolean;
  isStill: boolean;

  constructor(previous: CameraState, current: CameraState) {
    this.isZooming = current.ratio < previous.ratio;
    // NOTE: isUnzooming is not the inverse of isZooming, the camera can also stay at same level
    this.isUnzooming = current.ratio > previous.ratio;
    this.hasSameRatio = !this.isZooming && !this.isUnzooming;
    this.isPanning = current.x !== previous.x || current.y !== previous.y;
    this.isStill = this.hasSameRatio && !this.isPanning;
  }
}

/**
 * Class representing a single candidate for the label grid selection.
 *
 * It also describes a deterministic way to compare two candidates to assess
 * which one is better.
 */
class LabelCandidate {
  key: NodeKey;
  degree: number;
  size: number;

  constructor(key: NodeKey, size: number, degree: number) {
    this.key = key;
    this.size = size;
    this.degree = degree;
  }

  static compare(first: LabelCandidate, second: LabelCandidate): number {
    // First we compare by size
    if (first.size > second.size) return -1;
    if (first.size < second.size) return 1;

    // Then we tie-break by degree
    if (first.degree > second.degree) return -1;
    if (first.degree < second.degree) return 1;

    // Then since no two nodes can have the same key, we deterministically
    // tie-break by key
    if (first.key > second.key) return -1;

    // NOTE: this comparator cannot return 0
    return 1;
  }
}

/**
 * Class representing a 2D spatial grid divided into constant-size cells.
 */
export class LabelGrid {
  width = 0;
  height = 0;
  cellWidth = 0;
  cellHeight = 0;
  columns = 0;
  rows = 0;
  cells: Record<number, Array<LabelCandidate>> = {};

  resizeAndClear(dimensions: Dimensions, cell: Dimensions) {
    this.width = dimensions.width;
    this.height = dimensions.height;

    this.cellWidth = cell.width;
    this.cellHeight = cell.height;

    this.columns = Math.ceil(dimensions.width / cell.width);
    this.rows = Math.ceil(dimensions.height / cell.height);

    this.cells = {};
  }

  private getIndex(pos: Coordinates): number {
    const xIndex = Math.floor(pos.x / this.cellWidth);
    const yIndex = Math.floor(pos.y / this.cellHeight);

    return xIndex * this.columns + yIndex;
  }

  add(key: NodeKey, degree: number, size: number, pos: Coordinates): void {
    // TODO: degree might not be advisable
    const candidate = new LabelCandidate(key, size, 0);

    const index = this.getIndex(pos);
    let cell = this.cells[index];

    if (!cell) {
      cell = [];
      this.cells[index] = cell;
    }

    cell.push(candidate);
  }

  organize(): void {
    for (const k in this.cells) {
      const cell = this.cells[k];
      cell.sort(LabelCandidate.compare);
    }
  }

  getLabelsToDisplay(ratio: number): Array<NodeKey> {
    // TODO: always keep at least top N + on unzoomed => not necessary with threshold
    // TODO: memoize on pan
    // TODO: work on visible nodes to optimize? ^
    // TODO: adjust threshold lower, but increase cells a bit?

    const n = Math.ceil((DEFAULT_MAX_DENSITY * (this.cellHeight * this.cellWidth)) / ratio / ratio);

    const labels = [];

    for (const k in this.cells) {
      const cell = this.cells[k];

      for (let i = 0; i < Math.min(n, cell.length); i++) {
        labels.push(cell[i].key);
      }
    }
    // console.log(ratio, n, labels.length);
    return labels;
  }
}

/**
 * Label heuristic selecting labels to display from the list of currently
 * visible nodes (and some from the fringes of the frame).
 *
 * Under the hood, it dispatches nodes across a 2D grid to select the
 * worthiest node labels to display.
 *
 * @param  {object}         params          - Parameters:
 * @param  {object}           nodeDataCache - Cache storing nodes data.
 * @param  {Camera}           camera        - The renderer's camera.
 * @param  {object}           cell          - Dimensions of the grid cell.
 * @param  {Dimensions}       dimensions    - Dimensions of the rendering frame.
 * @param  {Graph}            graph         - The renderered graph.
 * @param  {LabelGridState}   gridState     - Current state of the label grid.
 * @param  {Array}            visibleNodes  - List of visible nodes as returned by the quadtree.
 * @return {Array}                          - The selected labels.
 */
// export function labelsToDisplayFromGrid(params: {
//   cache: Record<string, NodeDisplayData>;
//   camera: Camera;
//   cell: Dimensions | null;
//   dimensions: Dimensions;
//   graph: Graph;
//   gridState: LabelGridState;
//   visibleNodes: Array<NodeKey>;
// }): Array<NodeKey> {
//   const { cache, camera, cell, dimensions, graph, gridState, visibleNodes } = params;

//   // Camera state
//   const cameraState = camera.getState();
//   const previousCameraState = camera.getPreviousState();
//   let previousCamera: Camera | null = null;
//   let cameraMove: CameraMove | null = null;
//   let onlyPanning = false;

//   if (previousCameraState) {
//     previousCamera = Camera.from(previousCameraState);
//     cameraMove = new CameraMove(previousCameraState, cameraState);

//     // If grid state was already initialized and the camera did not move
//     // We can just return the same labels as before
//     if (gridState.initialized && cameraMove.isStill) {
//       return gridState.reuse();
//     }

//     const animationIsOver = !camera.isAnimated();

//     // If we are zooming, we wait until the animation is over to choose new labels
//     if (cameraMove.isZooming) {
//       if (!animationIsOver) return gridState.reuse();
//     }

//     // If we are unzooming we quantize and also choose new labels when the animation is over
//     else if (cameraMove.isUnzooming) {
//       // Unzoom quantization, i.e. we only chose new labels by 5% ratio increments
//       // NOTE: I relinearize the ratio to avoid exponential quantization
//       const linearRatio = Math.pow(cameraState.ratio, 1 / 1.5);
//       const quantized = Math.trunc(linearRatio * 100) % 5 === 0;

//       if (!quantized && !animationIsOver) {
//         return gridState.reuse();
//       }
//     }

//     onlyPanning = cameraMove.hasSameRatio && cameraMove.isPanning;
//   } else {
//     // If grid state is already initialized and we are here, it means
//     // that the camera was not updated at all since last time (it can be
//     // the case when running layout and user has not yet interacted).
//     if (gridState.initialized) return gridState.reuse();
//   }

//   // Selecting the correct cell to use
//   // NOTE: we use a larger cell when the graph is unzoomed to avoid
//   // visual cluttering by the labels, that are then larger than the graph itself
//   let cellToUse = cell ? cell : DEFAULT_CELL;
//   if (cameraState.ratio >= 1.3) cellToUse = DEFAULT_UNZOOMED_CELL;

//   const index: SpatialGridIndex<LabelCandidate> = new SpatialGridIndex(dimensions, cellToUse);

//   for (let i = 0, l = visibleNodes.length; i < l; i++) {
//     const node = visibleNodes[i];
//     const data = cache[node];
//     const newCandidate = new LabelCandidate(node, data.size, graph.degree(node), gridState.labelIsShown(node));
//     const pos = camera.framedGraphToViewport(dimensions, data);
//     const key = index.getKey(pos);
//     const isShownOnScreen = key !== undefined;

//     if (!isShownOnScreen) continue;

//     const currentCandidate = index.get(key as number);

//     // If we are panning while ratio remains the same, the label selection logic
//     // changes a bit to remain relevant.
//     // Basically, we need to keep all currently shown labels if their node is
//     // still visible. Then, we only need to consider adding labels of nodes that
//     // were not visible in the last frame, all while considering a short fringe
//     // outside of the frame in order to avoid weird apparitions/flickering.
//     if (onlyPanning) {
//       previousCamera = previousCamera as Camera;

//       if (!newCandidate.alreadyDisplayed) {
//         const previousPos = previousCamera.framedGraphToViewport(dimensions, data);
//         const wasWithinBounds = index.isWithinBounds(previousPos);

//         if (wasWithinBounds) continue;
//       }

//       if (!currentCandidate) {
//         index.set(key as number, newCandidate);
//       } else {
//         if (currentCandidate.alreadyDisplayed && newCandidate.alreadyDisplayed) {
//           if (newCandidate.isBetterThan(currentCandidate)) {
//             index.set(key as number, newCandidate);
//             index.keep(currentCandidate);
//           } else {
//             index.keep(newCandidate);
//           }
//         } else {
//           if (newCandidate.isBetterThan(currentCandidate)) {
//             index.set(key as number, newCandidate);
//           }
//         }
//       }
//     }

//     // In the general case, chosing a label is simply a matter of placing
//     // labels in a constant grid so that only one label per cell can be displayed
//     // In that case, nodes are ranked thusly:
//     //   1. If its label is already shown
//     //   2. By size
//     //   3. By degree
//     //   4. By key (which is arbitrary but deterministic)
//     else {
//       if (!currentCandidate || newCandidate.isBetterThan(currentCandidate)) {
//         index.set(key as number, newCandidate);
//       }
//     }
//   }

//   // Collecting results
//   const results = index.collect((c) => c.key);

//   // Updating grid state
//   gridState.update(results);

//   return results;
// }

/**
 * Label heuristic selecting edge labels to display, based on displayed node
 * labels
 *
 * @param  {object} params                 - Parameters:
 * @param  {object}   nodeDataCache        - Cache storing nodes data.
 * @param  {object}   edgeDataCache        - Cache storing edges data.
 * @param  {Set}      displayedNodeLabels  - Currently displayed node labels.
 * @param  {Set}      highlightedNodes     - Highlighted nodes.
 * @param  {Graph}    graph                - The rendered graph.
 * @param  {string}   hoveredNode          - Hovered node (optional)
 * @return {Array}                         - The selected labels.
 */
export function edgeLabelsToDisplayFromNodes(params: {
  displayedNodeLabels: Set<NodeKey>;
  highlightedNodes: Set<NodeKey>;
  graph: Graph;
  hoveredNode: NodeKey | null;
}): Array<EdgeKey> {
  const { graph, hoveredNode, highlightedNodes, displayedNodeLabels } = params;

  const worthyEdges: Array<EdgeKey> = [];

  // TODO: the code below can be optimized using #.forEach and batching the code per adj

  // We should display an edge's label if:
  //   - Any of its extremities is highlighted or hovered
  //   - Both of its extremities has its label shown
  graph.forEachEdge((edge, _, source, target) => {
    if (
      source === hoveredNode ||
      target === hoveredNode ||
      highlightedNodes.has(source) ||
      highlightedNodes.has(target) ||
      (displayedNodeLabels.has(source) && displayedNodeLabels.has(target))
    ) {
      worthyEdges.push(edge);
    }
  });

  return worthyEdges;
}
