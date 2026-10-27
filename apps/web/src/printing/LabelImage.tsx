/**
 * The T14 sticker SVG shown as an image (MM-T39). The SVG comes from the server, built from
 * escaped values; loading it through an <img> data URL means nothing in it can run or touch the
 * page, and user text is never injected as markup.
 */
export function LabelImage({
  svg,
  readableId,
  className,
}: {
  svg: string;
  readableId: string;
  className?: string;
}) {
  return (
    <img
      className={className}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={`Label for storage unit ${readableId}`}
      // 3.5 × 1.5 in at 96 CSS px per inch; CSS sets the real size.
      width={336}
      height={144}
    />
  );
}
