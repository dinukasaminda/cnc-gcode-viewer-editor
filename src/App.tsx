import { useEffect, useState } from 'react';
import {
  APP_TOOLS,
  ensureToolUrl,
  pathForTool,
  toolFromPathname,
  type AppToolId,
} from './core/routing';
import ModelSimplifier from './tools/ModelSimplifier';
import PcbGcodeViewer from './tools/PcbGcodeViewer';
import './App.css';

function readTool(): AppToolId {
  return toolFromPathname(window.location.pathname);
}

export default function App() {
  const [tool, setToolState] = useState<AppToolId>(readTool);

  useEffect(() => {
    const redirect = ensureToolUrl(window.location.pathname);
    if (redirect) {
      window.history.replaceState({ tool: toolFromPathname(redirect) }, '', redirect);
    }

    const onPop = () => setToolState(readTool());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const meta = APP_TOOLS.find((t) => t.id === tool);
    document.title = meta ? `${meta.label} · SKL Tools` : 'SKL Tools';
  }, [tool]);

  const setTool = (id: AppToolId) => {
    const next = pathForTool(id);
    if (window.location.pathname !== next) {
      window.history.pushState({ tool: id }, '', next);
    }
    setToolState(id);
  };

  return (
    <div className="app-shell">
      <nav className="tool-switcher" aria-label="Main tools">
        <div className="tool-switcher-brand">SKL Tools</div>
        <div className="tool-switcher-tabs" role="tablist">
          {APP_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tool === t.id}
              className={tool === t.id ? 'tool-tab active' : 'tool-tab'}
              title={t.description}
              onClick={() => setTool(t.id)}
            >
              <span className="tool-tab-short">{t.short}</span>
              <span className="tool-tab-label">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="tool-switcher-url mono" title="Current tool URL">
          {pathForTool(tool)}
        </div>
      </nav>
      <div className="tool-host">
        {/* Keep both mounted so large 3MF / PCB session state survives tab switches */}
        <div className={tool === 'simplify' ? 'tool-pane active' : 'tool-pane'} hidden={tool !== 'simplify'}>
          <ModelSimplifier />
        </div>
        <div className={tool === 'pcb' ? 'tool-pane active' : 'tool-pane'} hidden={tool !== 'pcb'}>
          <PcbGcodeViewer />
        </div>
      </div>
    </div>
  );
}
