/** FLIP (First/Last/Invert/Play) helper for reordered lists.
    After `rows` were re-ordered in the DOM, animate them from their previous
    positions (`prev` = their top offsets before the reorder) so they glide to
    the new ones. The smooth motion comes from the CSS transition on transform. */
export function flipReorder(rows: HTMLElement[], prev: number[]): void {
  rows.forEach((r, i) => {
    const dy = prev[i] - r.getBoundingClientRect().top;
    if (dy !== 0) {
      r.style.transform = `translateY(${dy}px)`;
      void r.getBoundingClientRect(); // reflow before removing the transform
      r.style.removeProperty("transform");
    }
  });
}
