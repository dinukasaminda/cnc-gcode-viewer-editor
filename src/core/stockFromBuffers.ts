import { HeightFieldStock } from './stock';
import type { StockSettings } from './types';
import type { WorkerResponse } from '../workers/simulate.worker';

export function stockFromWorkerResult(res: WorkerResponse): HeightFieldStock {
  if (
    res.depth == null ||
    res.copper == null ||
    res.voidMask == null ||
    res.cols == null ||
    res.rows == null
  ) {
    throw new Error('Incomplete worker result');
  }
  const settings: StockSettings = {
    width: res.widthMm!,
    height: res.heightMm!,
    thickness: res.thickness!,
    copperThickness: res.copperThickness!,
    originX: res.originX!,
    originY: res.originY!,
    surfaceZ: 0,
    margin: 0,
    resolution: res.resolution!,
    zMode: 'auto',
  };
  const stock = new HeightFieldStock(settings);
  const depth = new Float32Array(res.depth);
  const copper = new Uint8Array(res.copper);
  const voidMask = new Uint8Array(res.voidMask);
  if (depth.length !== stock.depth.length) {
    // Copy what fits if dimensions diverge slightly
    stock.depth.set(depth.subarray(0, Math.min(depth.length, stock.depth.length)));
    stock.copper.set(copper.subarray(0, Math.min(copper.length, stock.copper.length)));
    stock.voidMask.set(
      voidMask.subarray(0, Math.min(voidMask.length, stock.voidMask.length))
    );
  } else {
    stock.depth.set(depth);
    stock.copper.set(copper);
    stock.voidMask.set(voidMask);
  }
  return stock;
}
