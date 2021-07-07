/**
 * Sigma.js Labels Heuristics
 * ===========================
 *
 * Miscelleneous heuristics related to label display.
 * @module
 */
import Graph from "graphology";
import { EdgeKey, NodeKey } from "graphology-types";
import { Dimensions, Coordinates, EdgeDisplayData, NodeDisplayData, CameraState } from "../types";
import Camera from "./camera";

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

/**
 * Helpers.
 */
function axisAlignedRectangularCollision(
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

// TODO: cache camera position of selected nodes to avoid costly computations
// in anti-collision step
// TOOD: document a little bit more so future people can understand this mess

/**
 * Classes.
 */

// Class describing how the camera moved from between two of its states
// TODO: possibility to move this elsewhere if useful
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

class LabelCandidate {
  alreadyDisplayed: boolean;
  key: NodeKey;
  degree: number;
  size: number;

  constructor(key: NodeKey, size: number, degree: number, alreadyDisplayed: boolean) {
    this.alreadyDisplayed = alreadyDisplayed;
    this.key = key;
    this.size = size;
    this.degree = degree;
  }

  isBetterThan(other: LabelCandidate): boolean {
    // First we check which node is displayed
    const shown1 = this.alreadyDisplayed ? 1 : 0;
    const shown2 = other.alreadyDisplayed ? 1 : 0;

    if (shown1 > shown2) return true;
    if (shown1 < shown2) return false;

    // Then we compare by size
    if (this.size > other.size) return true;
    if (this.size < other.size) return false;

    // Then we tie-break by degree
    if (this.degree > other.degree) return true;
    if (this.degree < other.degree) return false;

    // Then since no two nodes can have the same key, we deterministically
    // tie-break by key
    if (this.key > other.key) return true;

    return false;
  }
}

class SpatialGridIndex<T> {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  items: Record<number, T> = {};
  additionalItems: Array<T> = [];

  constructor(dimensions: Dimensions, cell: Dimensions) {
    this.width = dimensions.width;
    this.height = dimensions.height;

    // NOTE: this code has undefined behavior if given floats I think
    const cellWidthRemainder = dimensions.width % cell.width;
    const cellHeightRemainder = dimensions.height % cell.height;

    this.cellWidth = cell.width + cellWidthRemainder / Math.floor(dimensions.width / cell.width);
    this.cellHeight = cell.height + cellHeightRemainder / Math.floor(dimensions.height / cell.height);

    // NOTE: we add 2 to the number of columns and rows to take into account
    // that nodes could be found on the fringes of the rendering frame
    // This is useful to consider those fringes to display labels before their
    // nodes can actually be shown on screen to avoid flickering
    this.columns = dimensions.width / this.cellWidth + 2;
    this.rows = dimensions.height / this.cellHeight + 2;
  }

  getKey(pos: Coordinates): number | undefined {
    // We offset the indices by one to take the fringes into account
    const x = Math.floor(pos.x / this.cellWidth) + 1;
    const y = Math.floor(pos.y / this.cellHeight) + 1;

    // Bound checks
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return;

    return x * this.columns + y;
  }

  isWithinBounds(pos: Coordinates): boolean {
    return this.getKey(pos) !== undefined;
  }

  isVisible(pos: Coordinates): boolean {
    return pos.x > 0 && pos.x <= this.width && pos.y > 0 && pos.y <= this.height;
  }

  set(key: number, candidate: T) {
    this.items[key] = candidate;
  }

  get(key: number): T | undefined {
    return this.items[key];
  }

  keep(candidate: T) {
    this.additionalItems.push(candidate);
  }

  collect<I>(callback: (item: T) => I): Array<I> {
    const items = [];

    for (const k in this.items) {
      items.push(callback(this.items[k]));
    }

    for (let i = 0, l = this.additionalItems.length; i < l; i++) {
      items.push(callback(this.additionalItems[i]));
    }

    return items;
  }
}

export class LabelGridState {
  initialized = false;
  displayedLabels: Set<NodeKey> = new Set();

  reset(): void {
    this.initialized = false;
    this.displayedLabels.clear();
  }

  reuse(): Array<NodeKey> {
    return Array.from(this.displayedLabels);
  }

  update(nodes: Array<NodeKey>): void {
    this.initialized = true;
    this.displayedLabels.clear();

    for (let i = 0, l = nodes.length; i < l; i++) {
      this.displayedLabels.add(nodes[i]);
    }
  }

  labelIsShown(node: NodeKey): boolean {
    return this.displayedLabels.has(node);
  }
}

export function labelsToDisplayFromGrid(params: {
  cache: Record<string, NodeDisplayData>;
  camera: Camera;
  cell: Dimensions | null;
  dimensions: Dimensions;
  graph: Graph;
  gridState: LabelGridState;
  visibleNodes: Array<NodeKey>;
}): Array<NodeKey> {
  const { cache, camera, cell, dimensions, graph, gridState, visibleNodes } = params;

  // Camera state
  const cameraState = camera.getState();
  const previousCameraState = camera.getPreviousState();
  let previousCamera: Camera | null = null;
  let cameraMove: CameraMove | null = null;
  let onlyPanning = false;

  if (previousCameraState) {
    previousCamera = Camera.from(previousCameraState);
    cameraMove = new CameraMove(previousCameraState, cameraState);

    // If grid state was already initialized and the camera did not move
    // We can just return the same labels as before
    if (gridState.initialized && cameraMove.isStill) {
      return gridState.reuse();
    }

    // Zoom quantization, i.e. we only chose new labels by 5% ratio increments
    if ((cameraMove.isZooming || cameraMove.isUnzooming) && Math.trunc(cameraState.ratio * 100) % 5 !== 0) {
      return gridState.reuse();
    }

    onlyPanning = cameraMove.hasSameRatio && cameraMove.isPanning;
  } else {
    // If grid state is already initialized and we are here, it means
    // that the camera was not updated at all since last time (it can be
    // the case when running layout and user has not yet interacted).
    if (gridState.initialized) return gridState.reuse();
  }

  // Selecting the correct cell to use
  // NOTE: we use a larger cell when the graph is unzoomed to avoid
  // visual cluttering by the labels, that are then larger than the graph itself
  let cellToUse = cell ? cell : DEFAULT_CELL;
  if (cameraState.ratio >= 1.3) cellToUse = DEFAULT_UNZOOMED_CELL;

  const index: SpatialGridIndex<LabelCandidate> = new SpatialGridIndex(dimensions, cellToUse);

  for (let i = 0, l = visibleNodes.length; i < l; i++) {
    const node = visibleNodes[i];
    const data = cache[node];
    const newCandidate = new LabelCandidate(node, data.size, graph.degree(node), gridState.labelIsShown(node));
    const pos = camera.framedGraphToViewport(dimensions, data);
    const key = index.getKey(pos);
    const isShownOnScreen = key !== undefined;

    if (!isShownOnScreen) continue;

    const currentCandidate = index.get(key as number);

    // If we are panning while ratio remains the same, the label selection logic
    // changes so that we are keeping all currently shown labels when relevant
    // TODO: edit docs
    if (onlyPanning) {
      previousCamera = previousCamera as Camera;

      // TODO: optimize by computing only when strictly necessary, i.e. when not already displayed
      const previousPos = previousCamera.framedGraphToViewport(dimensions, data);
      const wasWithinBounds = index.isWithinBounds(previousPos);

      if (!newCandidate.alreadyDisplayed && wasWithinBounds) continue;

      // TODO: document this hazy logic
      if (!currentCandidate) {
        index.set(key as number, newCandidate);
      } else {
        if (currentCandidate.alreadyDisplayed && newCandidate.alreadyDisplayed) {
          if (newCandidate.isBetterThan(currentCandidate)) {
            index.set(key as number, newCandidate);
            index.keep(currentCandidate);
          } else {
            index.keep(newCandidate);
          }
        } else {
          if (newCandidate.isBetterThan(currentCandidate)) {
            index.set(key as number, newCandidate);
          }
        }
      }
    }

    // In the general case, chosing a label is simply a matter of placing
    // labels in a constant grid so that only one label per cell can be displayed
    // In that case, nodes are ranked thusly:
    //   1. If its label is already shown
    //   2. By size
    //   3. By degree
    //   4. By key (which is arbitrary but deterministic)
    else {
      if (!currentCandidate || newCandidate.isBetterThan(currentCandidate)) {
        index.set(key as number, newCandidate);
      }
    }
  }

  // Collecting results
  const results = index.collect((c) => c.key);

  // Updating grid state
  gridState.update(results);

  return results;
}

/**
 * Label grid heuristic selecting labels to display.
 *
 * @param  {object} params                 - Parameters:
 * @param  {object}   cache                - Cache storing nodes' data.
 * @param  {Camera}   camera               - The renderer's camera.
 * @param  {Set}      displayedLabels      - Currently displayed labels.
 * @param  {Array}    visibleNodes         - Nodes visible for this render.
 * @param  {Graph}    graph                - The rendered graph.
 * @return {Array}                         - The selected labels.
 */
// export function labelsToDisplayFromGridOld(params: {
//   cache: { [key: string]: NodeDisplayData };
//   camera: Camera;
//   cell: { width: number; height: number } | null;
//   dimensions: Dimensions;
//   displayedLabels: Set<NodeKey>;
//   fontSize: number;
//   graph: Graph;
//   renderedSizeThreshold: number;
//   visibleNodes: NodeKey[];
// }): NodeKey[] {
//   const {
//     cache,
//     camera,
//     cell: userCell,
//     dimensions,
//     displayedLabels,
//     fontSize = 14,
//     graph,
//     renderedSizeThreshold = -Infinity,
//     visibleNodes,
//   } = params;

//   const cameraState = camera.getState();
//   const previousCameraState = camera.getPreviousState();

//   const previousCamera = new Camera();
//   previousCamera.setState(previousCameraState);

//   // State
//   // const cameraMove = new CameraMove(previousCameraState, cameraState);

//   const zooming = cameraState.ratio < previousCameraState.ratio;
//   const panning = cameraState.x !== previousCameraState.x || cameraState.y !== previousCameraState.y;
//   const unzooming = cameraState.ratio > previousCameraState.ratio; // NOTE: unzooming is not !zooming since the zoom can remain constant
//   const unzoomedPanning = panning && !zooming && !unzooming && cameraState.ratio >= 1;
//   const zoomedPanning = panning && displayedLabels.size && !zooming && !unzooming;

//   let shouldReturnSameLabels = false;

//   // Trick to discretize unzooming, i.e. we consider new labels when unzooming
//   // only every 5% increment so that labels won't blink too much
//   if (unzooming && Math.trunc(cameraState.ratio * 100) % 5 !== 0) shouldReturnSameLabels = true;

//   // If panning while unzoomed, we shouldn't change label selection
//   if (unzoomedPanning && displayedLabels.size !== 0) shouldReturnSameLabels = true;

//   // When unzoomed & zooming
//   if (zooming && cameraState.ratio >= 1) shouldReturnSameLabels = true;

//   if (shouldReturnSameLabels) return Array.from(displayedLabels);

//   // Adapting cell dimensions
//   let cell = userCell ? userCell : DEFAULT_CELL;

//   if (cameraState.ratio >= 1.3) cell = DEFAULT_UNZOOMED_CELL;

//   const cwr = dimensions.width % cell.width;
//   const cellWidth = cell.width + cwr / Math.floor(dimensions.width / cell.width);

//   const chr = dimensions.height % cell.height;
//   const cellHeight = cell.height + chr / Math.floor(dimensions.height / cell.height);

//   const adjustedWidth = dimensions.width + cellWidth,
//     adjustedHeight = dimensions.height + cellHeight,
//     adjustedX = -cellWidth,
//     adjustedY = -cellHeight;

//   const panningWidth = dimensions.width + cellWidth / 2,
//     panningHeight = dimensions.height + cellHeight / 2,
//     panningX = -(cellWidth / 2),
//     panningY = -(cellHeight / 2);

//   const worthyLabels: Array<NodeKey> = [];
//   const grid: Record<string, NodeKey> = {};

//   let maxSize = -Infinity,
//     biggestNode: NodeKey | null = null;

//   for (let i = 0, l = visibleNodes.length; i < l; i++) {
//     const node = visibleNodes[i],
//       nodeData = cache[node];

//     // We filter hidden nodes
//     if (nodeData.hidden) continue;

//     // We filter nodes having a rendered size less than a certain thresold
//     if (camera.scaleSize(nodeData.size) < renderedSizeThreshold) continue;

//     // Finding our node's cell in the grid
//     const pos = camera.framedGraphToViewport(dimensions, nodeData);

//     // Node is not actually visible on screen
//     // NOTE: can optimize margin on the right side (only if we know where the labels go)
//     if (pos.x < adjustedX || pos.x > adjustedWidth || pos.y < adjustedY || pos.y > adjustedHeight) continue;

//     // Keeping track of the maximum node size for certain cases
//     if (nodeData.size > maxSize) {
//       maxSize = nodeData.size;
//       biggestNode = node;
//     }

//     // If panning when zoomed, we consider only displayed labels and newly
//     // visible nodes
//     if (zoomedPanning) {
//       const ppos = previousCamera.framedGraphToViewport(dimensions, nodeData);

//       // Was node visible earlier?
//       if (ppos.x >= panningX && ppos.x <= panningWidth && ppos.y >= panningY && ppos.y <= panningHeight) {
//         // Was the label displayed?
//         if (!displayedLabels.has(node)) continue;
//       }
//     }

//     const xKey = Math.floor(pos.x / cellWidth),
//       yKey = Math.floor(pos.y / cellHeight);

//     const key = `${xKey}§${yKey}`;

//     if (typeof grid[key] === "undefined") {
//       // This cell is not yet occupied
//       grid[key] = node;
//     } else {
//       // We must solve a conflict in this cell
//       const currentNode = grid[key],
//         currentNodeData = cache[currentNode];

//       // We prefer already displayed labels
//       if (displayedLabels.size > 0) {
//         const n1 = displayedLabels.has(node),
//           n2 = displayedLabels.has(currentNode);

//         if (!n1 && n2) {
//           continue;
//         }

//         if (n1 && !n2) {
//           grid[key] = node;
//           continue;
//         }

//         if ((zoomedPanning || zooming) && n1 && n2) {
//           worthyLabels.push(node);
//           continue;
//         }
//       }

//       // In case of size & degree equality, we use the node's key so that the
//       // process remains deterministic
//       let won = false;

//       if (nodeData.size > currentNodeData.size) {
//         won = true;
//       } else if (nodeData.size === currentNodeData.size) {
//         const nodeDegree = graph.degree(node),
//           currentNodeDegree = graph.degree(currentNode);

//         if (nodeDegree > currentNodeDegree) {
//           won = true;
//         } else if (nodeDegree === currentNodeDegree) {
//           if (node > currentNode) won = true;
//         }
//       }

//       if (won) grid[key] = node;
//     }
//   }

//   // Compiling the labels
//   let biggestNodeShown: boolean = worthyLabels.some((node) => node === biggestNode);

//   for (const key in grid) {
//     const node = grid[key];

//     if (node === biggestNode) biggestNodeShown = true;

//     worthyLabels.push(node);
//   }

//   // Always keeping biggest node shown on screen
//   if (!biggestNodeShown && biggestNode) worthyLabels.push(biggestNode);

//   // Basic anti-collision
//   const collisions = new Set();

//   for (let i = 0, l = worthyLabels.length; i < l; i++) {
//     const n1 = worthyLabels[i],
//       d1 = cache[n1],
//       p1 = camera.framedGraphToViewport(dimensions, d1);

//     if (collisions.has(n1)) continue;

//     for (let j = i + 1; j < l; j++) {
//       const n2 = worthyLabels[j],
//         d2 = cache[n2],
//         p2 = camera.framedGraphToViewport(dimensions, d2);

//       const c = axisAlignedRectangularCollision(
//         // First abstract bbox
//         p1.x,
//         p1.y,
//         d1.label.length * 8,
//         fontSize,

//         // Second abstract bbox
//         p2.x,
//         p2.y,
//         d2.label.length * 8,
//         fontSize,
//       );

//       if (c) {
//         // NOTE: add degree as tie-breaker here if required in the future
//         // NOTE: add final stable tie-breaker using node key if required
//         if (d1.size < d2.size) collisions.add(n1);
//         else collisions.add(n2);
//       }
//     }
//   }

//   // console.log(collisions)

//   return worthyLabels.filter((l) => !collisions.has(l));
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
  nodeDataCache: { [key: string]: NodeDisplayData };
  edgeDataCache: { [key: string]: EdgeDisplayData };
  displayedNodeLabels: Set<NodeKey>;
  highlightedNodes: Set<NodeKey>;
  graph: Graph;
  hoveredNode: NodeKey | null;
}): Array<EdgeKey> {
  const { nodeDataCache, edgeDataCache, graph, hoveredNode, highlightedNodes, displayedNodeLabels } = params;

  const worthyEdges = new Set<EdgeKey>();
  const displayedNodeLabelsArray = Array.from(displayedNodeLabels);

  // Each edge connecting a highlighted node has its label displayed if the other extremity is not hidden:
  const highlightedNodesArray = Array.from(highlightedNodes);
  if (hoveredNode && !highlightedNodes.has(hoveredNode)) highlightedNodesArray.push(hoveredNode);
  for (let i = 0; i < highlightedNodesArray.length; i++) {
    const key = highlightedNodesArray[i];
    const edges = graph.edges(key);

    for (let j = 0; j < edges.length; j++) {
      const edgeKey = edges[j];
      const extremities = graph.extremities(edgeKey),
        sourceData = nodeDataCache[extremities[0]],
        targetData = nodeDataCache[extremities[1]],
        edgeData = edgeDataCache[edgeKey];
      if (edgeData.hidden && sourceData.hidden && targetData.hidden) {
        worthyEdges.add(edgeKey);
      }
    }
  }

  // Each edge connecting two nodes with visible labels has its label displayed:
  for (let i = 0; i < displayedNodeLabelsArray.length; i++) {
    const key = displayedNodeLabelsArray[i];
    const edges = graph.outboundEdges(key);

    for (let j = 0; j < edges.length; j++)
      if (!edgeDataCache[edges[j]].hidden && displayedNodeLabels.has(graph.opposite(key, edges[j])))
        worthyEdges.add(edges[j]);
  }

  return Array.from(worthyEdges);
}
