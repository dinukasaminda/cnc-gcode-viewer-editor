import { applyMaterialRemoval } from '../core/materialRemoval';
import type { JobFile, StockSettings } from '../core/types';

export interface WorkerRequest {
  type: 'simulate';
  jobs: JobFile[];
  stock: StockSettings;
  uptoGlobalIndex?: number;
}

export interface WorkerResponse {
  type: 'done' | 'progress' | 'error';
  progress?: number;
  depth?: ArrayBuffer;
  copper?: ArrayBuffer;
  voidMask?: ArrayBuffer;
  cols?: number;
  rows?: number;
  widthMm?: number;
  heightMm?: number;
  originX?: number;
  originY?: number;
  resolution?: number;
  thickness?: number;
  copperThickness?: number;
  effectiveGrooveWidthMm?: number;
  appliedSegments?: number;
  message?: string;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'simulate') return;
  try {
    const result = applyMaterialRemoval(msg.jobs, msg.stock, {
      uptoGlobalIndex: msg.uptoGlobalIndex,
      onProgress: (p) => {
        const res: WorkerResponse = { type: 'progress', progress: p.progress };
        self.postMessage(res);
      },
    });

    const { stock } = result;
    const depth = stock.depth.slice();
    const copper = stock.copper.slice();
    const voidMask = stock.voidMask.slice();
    const res: WorkerResponse = {
      type: 'done',
      depth: depth.buffer as ArrayBuffer,
      copper: copper.buffer as ArrayBuffer,
      voidMask: voidMask.buffer as ArrayBuffer,
      cols: stock.cols,
      rows: stock.rows,
      widthMm: stock.widthMm,
      heightMm: stock.heightMm,
      originX: stock.originX,
      originY: stock.originY,
      resolution: stock.resolution,
      thickness: stock.thickness,
      copperThickness: stock.copperThickness,
      effectiveGrooveWidthMm: result.effectiveGrooveWidthMm,
      appliedSegments: result.appliedSegments,
    };
    self.postMessage(res, {
      transfer: [depth.buffer, copper.buffer, voidMask.buffer],
    });
  } catch (e) {
    const res: WorkerResponse = {
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(res);
  }
};
