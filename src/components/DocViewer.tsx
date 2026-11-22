"use client";
import { useRef, useState } from "react";
import { ExternalLink, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";

/**
 * In-page document viewer for the split review layout. PDFs use the browser's own PDF engine (page navigation,
 * zoom, text search, rotation, progressive rendering) inside a sandbox-free same-origin frame; photographs get
 * zoom and rotation. Both can go full screen without leaving the case.
 */
export function DocViewer({ src, mime, title }: { src: string; mime: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const image = mime.startsWith("image/");
  const full = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };
  return (
    <div className="doc-viewer" ref={box}>
      <div className="doc-viewer-bar" role="toolbar" aria-label="Document viewer">
        {image && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">
              <ZoomOut className="icon" aria-hidden="true" />
            </button>
            <span className="small tnum" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">
              <ZoomIn className="icon" aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRot((r) => (r + 90) % 360)} aria-label="Rotate 90 degrees">
              <RotateCw className="icon" aria-hidden="true" />
            </button>
          </>
        )}
        {!image && <span className="small muted">Use the viewer&apos;s controls to move between pages, zoom, rotate or search the text.</span>}
        <span style={{ flex: 1 }} />
        <a className="btn btn-sm btn-ghost" href={src} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab">
          <ExternalLink className="icon" aria-hidden="true" />
        </a>
        <button type="button" className="btn btn-sm btn-ghost" onClick={full} aria-label="Full screen">
          <Maximize2 className="icon" aria-hidden="true" />
        </button>
      </div>
      {image ? (
        <div className="doc-viewer-image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={title} style={{ transform: `scale(${zoom}) rotate(${rot}deg)` }} />
        </div>
      ) : (
        <iframe className="doc-viewer-frame" src={`${src}#view=FitH`} title={title} />
      )}
    </div>
  );
}
