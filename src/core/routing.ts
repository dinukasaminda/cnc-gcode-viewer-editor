export type AppToolId = 'simplify' | 'pcb';

export interface AppTool {
  id: AppToolId;
  path: string;
  label: string;
  short: string;
  description: string;
}

/** First entry is the default tool. */
export const APP_TOOLS: AppTool[] = [
  {
    id: 'simplify',
    path: '/simplify',
    label: '3MF Simplifier',
    short: '3MF',
    description: 'Remove small details and decimate 3MF meshes',
  },
  {
    id: 'pcb',
    path: '/pcb',
    label: 'PCB CNC',
    short: 'PCB',
    description: 'FlatCAM G-code board simulator',
  },
];

export const DEFAULT_TOOL: AppToolId = 'simplify';

export function toolFromPathname(pathname: string): AppToolId {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/pcb' || path.startsWith('/pcb/')) return 'pcb';
  if (path === '/simplify' || path.startsWith('/simplify/')) return 'simplify';
  return DEFAULT_TOOL;
}

export function pathForTool(id: AppToolId): string {
  return APP_TOOLS.find((t) => t.id === id)?.path ?? '/simplify';
}

/** Normalize `/` → `/simplify` so the first tool always has a clear URL. */
export function ensureToolUrl(pathname: string): string | null {
  const tool = toolFromPathname(pathname);
  const canonical = pathForTool(tool);
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === canonical) return null;
  if (normalized === '/' || !APP_TOOLS.some((t) => normalized === t.path || normalized.startsWith(t.path + '/'))) {
    return canonical;
  }
  return null;
}
