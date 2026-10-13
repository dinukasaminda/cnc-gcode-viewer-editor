export type ToolType = 'vbit' | 'endmill' | 'drill';

export type ViewMode =
  | 'final'
  | 'toolpaths'
  | 'final+toolpaths'
  | 'copper-removal'
  | 'depth-heatmap';

export type CameraMode = 'perspective' | 'top';

export interface VBitTool {
  type: 'vbit';
  tipDiameter: number;
  angle: number;
  shankDiameter: number;
}

export interface EndMillTool {
  type: 'endmill';
  diameter: number;
}

export interface DrillTool {
  type: 'drill';
  diameter: number;
}

export type Tool = VBitTool | EndMillTool | DrillTool;

export interface StockSettings {
  width: number;
  height: number;
  thickness: number;
  copperThickness: number;
  originX: number;
  originY: number;
  surfaceZ: number;
  margin: number;
  resolution: number;
  /** How cut depth is derived from Z */
  zMode: 'auto' | 'standard' | 'positive-depth';
}

export interface ParsedMetadata {
  toolDiameter?: number;
  zCut?: number;
  zMove?: number;
  feedXY?: number;
  feedZ?: number;
  spindle?: number;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  units?: 'mm' | 'inch';
  name?: string;
}

export type MoveType = 'rapid' | 'cut' | 'arc';

export interface MotionSegment {
  index: number;
  lineNumber: number;
  type: MoveType;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  feedrate: number;
  spindleOn: boolean;
  spindleRpm: number;
  /** Arc fields */
  i?: number;
  j?: number;
  clockwise?: boolean;
  raw: string;
}

export interface ParseResult {
  segments: MotionSegment[];
  metadata: ParsedMetadata;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  warnings: string[];
  units: 'mm' | 'inch';
  zConvention: 'standard' | 'positive-depth';
}

export interface JobFile {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  tool: Tool;
  parse?: ParseResult;
  color: string;
}

export interface ValidationWarning {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  lineNumber?: number;
}

export interface SimulationState {
  playing: boolean;
  speed: number;
  segmentIndex: number;
  progress: number;
  x: number;
  y: number;
  z: number;
  feedrate: number;
  spindleOn: boolean;
  spindleRpm: number;
  activeTool: string;
  currentLine: string;
  lineNumber: number;
}

export interface Measurement {
  id: string;
  kind: 'distance' | 'depth' | 'point';
  label: string;
  valueMm: number;
  points: { x: number; y: number; z: number }[];
}

/** Standard 1 oz copper cladding thickness (mm). */
export const STANDARD_COPPER_THICKNESS_MM = 0.035;

/** Common copper weights for PCB stock. */
export const COPPER_THICKNESS_PRESETS = [
  { label: '1 oz (standard)', mm: 0.035 },
  { label: '½ oz', mm: 0.0175 },
  { label: '2 oz', mm: 0.07 },
] as const;

export const DEFAULT_STOCK: StockSettings = {
  width: 50,
  height: 25,
  thickness: 1.6,
  copperThickness: STANDARD_COPPER_THICKNESS_MM,
  originX: 0,
  originY: 0,
  surfaceZ: 0,
  margin: 1,
  resolution: 0.025,
  zMode: 'auto',
};

export const DEFAULT_VBIT: VBitTool = {
  type: 'vbit',
  tipDiameter: 0.1,
  angle: 30,
  shankDiameter: 3.175,
};

export const DEFAULT_DRILL: DrillTool = {
  type: 'drill',
  diameter: 1.0,
};

export const DEFAULT_ENDMILL: EndMillTool = {
  type: 'endmill',
  diameter: 1.0,
};

export const JOB_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];
