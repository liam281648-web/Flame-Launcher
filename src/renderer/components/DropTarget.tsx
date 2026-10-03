import { useCallback, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Download, Loader2, PackagePlus } from 'lucide-react';
import { useLauncher } from '../state/store';

/**
 * True when a drag actually carries files from the OS.
 *
 * React's synthetic `dragenter` fires for text and links too, and showing an
 * import overlay for a dragged word from a webpage would be both wrong and
 * confusing. `types` is the reliable signal across Chromium versions.
 */
function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, 'Files');
}

/**
 * Depth counter for `dragleave`.
 *
 * `dragleave` fires for every child element the pointer crosses, so a naive
 * boolean flickers off the moment the cursor moves onto a nested node — the
 * overlay strobes across the whole grid. Counting enter/leave pairs and only
 * clearing at zero is the standard fix.
 */
export function useDropZone(onFiles: (files: File[]) => void) {
  const [isOver, setIsOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current += 1;
    setIsOver(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    // Required on every drag event, or Chromium refuses the drop entirely.
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setIsOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return {
    isOver,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop: handleDrop },
  };
}

export interface DropTargetProps {
  /** Instance the drop lands in; shown in the overlay. */
  instanceName: string;
  onFiles: (files: File[]) => void;
  children: ReactNode;
  /** `full` covers the viewport (a whole view), `inset` frames a card. */
  variant?: 'full' | 'inset';
}

/**
 * Drop target plus its overlay.
 *
 * `stopPropagation` on every drag event is what makes nesting work: the whole
 * Instances view and each individual card are both targets, and without it a
 * card drop would also trigger the view-level import into the active instance.
 */
export function DropTarget({
  instanceName,
  onFiles,
  children,
  variant = 'inset',
}: DropTargetProps) {
  const { isOver, handlers } = useDropZone(onFiles);

  return (
    <div {...handlers} className={`droptarget droptarget--${variant}${isOver ? ' droptarget--over' : ''}`}>
      {children}
      {isOver ? <DropOverlay instanceName={instanceName} /> : null}
    </div>
  );
}

/**
 * The visual feedback.
 *
 * Rendered only while a drag is in flight, and `pointer-events: none` in CSS so
 * it can never swallow the drop event it is describing.
 */
function DropOverlay({ instanceName }: { instanceName: string }) {
  const importing = useLauncher((s) => s.importing);
  const progress = useLauncher((s) => s.importProgress);

  const busy = importing && progress?.phase === 'working';
  const pct =
    busy && progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  return (
    <div className="dropoverlay" aria-hidden="true">
      <div className="dropoverlay__panel">
        {busy ? (
          <>
            <Loader2 size={30} className="spin dropoverlay__icon" />
            <span className="dropoverlay__title">Importing {progress?.fileName ?? '…'}</span>
            <span className="dropoverlay__hint">
              {pct > 0 ? `${pct}% — downloading mods` : 'Extracting…'}
            </span>
            <span className="dropoverlay__track">
              <span className="dropoverlay__fill" style={{ width: `${Math.max(4, pct)}%` }} />
            </span>
          </>
        ) : (
          <>
            <div className="dropoverlay__glyph">
              {progress?.phase === 'done' ? <Download size={28} /> : <PackagePlus size={28} />}
            </div>
            <span className="dropoverlay__title">Drop to import into {instanceName}</span>
            <span className="dropoverlay__hint">
              Mods, resource packs, shaders and modpacks
            </span>
            <span className="dropoverlay__exts">
              <code>.jar</code>
              <code>.zip</code>
              <code>.mrpack</code>
            </span>
          </>
        )}
      </div>
    </div>
  );
}