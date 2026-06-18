const ORIGINAL_TITLE = 'PD Console';
const CANVAS_SIZE = 32;
const DYNAMIC_FAVICON_ID = 'pd-dynamic-favicon';

function drawBaseFavicon(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.fillStyle = '#d4a853';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PD', CANVAS_SIZE / 2, CANVAS_SIZE / 2);
}

function drawRedDot(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.arc(CANVAS_SIZE - 6, 6, 5, 0, Math.PI * 2);
  ctx.fill();
}

export function renderFaviconDataUrl(totalCount: number): string {
  if (typeof document === 'undefined') return '';

  // eslint-disable-next-line no-undef
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  drawBaseFavicon(ctx);
  if (totalCount > 0) {
    drawRedDot(ctx);
  }

  return canvas.toDataURL('image/png');
}

export function updateFaviconAndTitle(pendingCount: number, degradedCount: number): void {
  if (typeof document === 'undefined') return;

  const totalCount = pendingCount + degradedCount;

  // eslint-disable-next-line no-undef
  document.title = totalCount > 0
    ? `(${totalCount}) PD Governance Workspace`
    : ORIGINAL_TITLE;

  // eslint-disable-next-line no-undef
  let link = document.getElementById(DYNAMIC_FAVICON_ID) as HTMLLinkElement | null;
  if (!link) {
    // eslint-disable-next-line no-undef
    link = document.createElement('link');
    link.id = DYNAMIC_FAVICON_ID;
    link.rel = 'icon';
    link.type = 'image/png';
    // eslint-disable-next-line no-undef
    document.head.appendChild(link);
  }

  const dataUrl = renderFaviconDataUrl(totalCount);
  if (dataUrl) {
    link.href = dataUrl;
  }
}

export function resetFaviconAndTitle(): void {
  if (typeof document === 'undefined') return;
  // eslint-disable-next-line no-undef
  document.title = ORIGINAL_TITLE;
  // eslint-disable-next-line no-undef
  document.getElementById(DYNAMIC_FAVICON_ID)?.remove();
}
