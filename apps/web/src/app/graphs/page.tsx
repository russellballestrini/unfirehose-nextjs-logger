'use client';

import { useState, useRef, useEffect } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface GraphData {
  svg: string;
  nodeCount: number;
  edgeCount: number;
  dot: string;
  error?: string;
  detail?: string;
}

const VIEWS = [
  { id: 'sessions', label: 'Sessions', desc: 'Project clusters, session nodes sized by tokens, delegation edges' },
  { id: 'tools', label: 'Tool Flow', desc: 'How tools chain together — edge weight = transition frequency' },
  { id: 'projects', label: 'Projects', desc: 'Projects sized by cost, linked by tool usage similarity' },
  { id: 'timeline', label: 'Timeline', desc: 'Sessions plotted by day, colored by output intensity' },
] as const;

export default function GraphPage() {
  const [view, setView] = useState<string>('sessions');
  const [layout, setLayout] = useState<'TB' | 'LR'>('TB');
  const [showDot, setShowDot] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const qs = new URLSearchParams({ view });
  if (layout !== 'TB') qs.set('layout', layout);

  const { data, error, isLoading } = useSWR<GraphData>(
    `/api/graph?${qs}`,
    fetcher
  );

  const currentView = VIEWS.find(v => v.id === view);

  // Reset zoom/pan on view change
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset */
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [view]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.1, Math.min(5, z * delta)));
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }

  function handleMouseUp() {
    setDragging(false);
  }

  function fitToView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <PageContext
        pageType="graph"
        summary={`Graph: ${view}. ${data?.nodeCount ?? 0} nodes, ${data?.edgeCount ?? 0} edges.`}
        metrics={{ view, nodes: data?.nodeCount ?? 0, edges: data?.edgeCount ?? 0 }}
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0 flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold">Graph Explorer</h1>
          {currentView && (
            <p className="text-xs text-[var(--color-muted)]">{currentView.desc}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View selector */}
          <div className="flex rounded border border-[var(--color-border)] overflow-hidden">
            {VIEWS.map(v => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                  view === v.id
                    ? 'bg-[var(--color-accent)] text-black font-bold'
                    : 'bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {/* Layout toggle */}
          {view !== 'timeline' && (
            <div className="flex rounded border border-[var(--color-border)] overflow-hidden">
              <button
                onClick={() => setLayout('TB')}
                className={`px-2 py-1.5 text-xs cursor-pointer ${layout === 'TB' ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]' : 'bg-[var(--color-surface)] text-[var(--color-muted)]'}`}
                title="Top to bottom"
              >
                ↓
              </button>
              <button
                onClick={() => setLayout('LR')}
                className={`px-2 py-1.5 text-xs cursor-pointer ${layout === 'LR' ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]' : 'bg-[var(--color-surface)] text-[var(--color-muted)]'}`}
                title="Left to right"
              >
                →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stats + controls */}
      {data && !data.error && (
        <div className="flex items-center gap-4 text-sm text-[var(--color-muted)] mb-2 shrink-0">
          <span>{data.nodeCount} nodes</span>
          <span>{data.edgeCount} edges</span>
          <span className="text-xs">Zoom: {(zoom * 100).toFixed(0)}%</span>
          <button onClick={fitToView} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">
            Reset view
          </button>
          <button onClick={() => setZoom(z => Math.min(5, z * 1.3))} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">
            Zoom in
          </button>
          <button onClick={() => setZoom(z => Math.max(0.1, z * 0.7))} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">
            Zoom out
          </button>
          <button
            onClick={() => {
              if (!data?.dot) return;
              const blob = new Blob([data.dot], { type: 'text/vnd.graphviz' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${view}-graph.dot`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer ml-auto"
          >
            Download .dot
          </button>
          <button
            onClick={() => setShowDot(!showDot)}
            className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer"
          >
            {showDot ? 'Hide' : 'Show'} DOT
          </button>
        </div>
      )}

      {showDot && data?.dot && (
        <pre className="p-4 bg-[var(--color-background)] border border-[var(--color-border)] rounded text-xs text-[var(--color-muted)] overflow-x-auto max-h-48 overflow-y-auto mb-2 shrink-0">
          {data.dot}
        </pre>
      )}

      {/* Graph viewport */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-[var(--color-muted)]">
          Rendering {currentView?.label.toLowerCase()} graph...
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center text-[var(--color-error)]">
          Failed to load graph
        </div>
      )}

      {data?.error && (
        <div className="flex-1 border border-[var(--color-border)] rounded bg-[var(--color-surface)] p-6 overflow-auto">
          <div className="text-[var(--color-error)] mb-2">{data.error}</div>
          <pre className="text-xs text-[var(--color-muted)] whitespace-pre-wrap">{data.detail}</pre>
        </div>
      )}

      {data?.svg && !data.error && (
        <div
          ref={svgContainerRef}
          className="flex-1 min-h-0 border border-[var(--color-border)] rounded bg-[var(--color-background)] overflow-hidden cursor-grab active:cursor-grabbing select-none"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              width: 'fit-content',
            }}
            className="p-4"
            dangerouslySetInnerHTML={{ __html: data.svg }}
          />
        </div>
      )}
    </div>
  );
}
