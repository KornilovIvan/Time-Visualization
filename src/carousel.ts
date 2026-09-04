import { formatDate, parseDate } from "./parser";
import { addDays, startOfWeek } from "./dates";
import type { Level, ViewHost } from "./viewHost";
import { fillDayCard, fillMonthSlide, fillWeekSlide } from "./dayRender";

/** Per-level carousel metadata: DOM classes, movement axis, sizes, cursor shift, slide filling */
export interface CarouselMeta {
  paneCls: string;
  focusCls: string;
  trackCls: string;
  slideCls: string;
  axis: "x" | "y";
  slideRatio: number;
  duration: number;
  lazyNeighbors: boolean;
  keyOf: (d: Date) => string;
  advance: (d: Date, dir: 1 | -1) => Date;
  fill: (slide: HTMLElement, key: string) => void;
}

export function getCarouselMeta(view: ViewHost, level: Level): CarouselMeta {
  if (level === "day") {
    return {
      paneCls: "tv-day",
      focusCls: "tv-day-focus",
      trackCls: "tv-day-track",
      slideCls: "tv-day-slide",
      axis: "x",
      slideRatio: 0.93,
      duration: 240,
      lazyNeighbors: false,
      keyOf: (d) => formatDate(d),
      advance: (d, dir) => addDays(d, dir),
      fill: (slide, key) => fillDayCard(view, slide, parseDate(key)),
    };
  }
  if (level === "week") {
    return {
      paneCls: "tv-week",
      focusCls: "tv-week-focus",
      trackCls: "tv-week-track",
      slideCls: "tv-week-slide",
      axis: "y",
      slideRatio: 0.9,
      duration: 380,
      lazyNeighbors: false,
      keyOf: (d) => formatDate(startOfWeek(d)),
      advance: (d, dir) => addDays(d, dir * 7),
      fill: (slide, key) => fillWeekSlide(view, slide, parseDate(key)),
    };
  }
  return {
    paneCls: "tv-month",
    focusCls: "tv-month-focus",
    trackCls: "tv-month-track",
    slideCls: "tv-month-slide",
    axis: "y",
    slideRatio: 1,
    duration: 380,
    // Month fills neighbor slides lazily in rAF — faster opening
    lazyNeighbors: true,
    keyOf: (d) => `${d.getFullYear()}-${d.getMonth()}`,
    advance: (d, dir) => new Date(d.getFullYear(), d.getMonth() + dir, 1),
    fill: (slide, key) => {
      const [yy, mm] = key.split("-").map(Number);
      if (Number.isFinite(yy) && Number.isFinite(mm)) fillMonthSlide(view, slide, new Date(yy, mm, 1));
    },
  };
}

export function buildSlide(d: Date, meta: CarouselMeta): HTMLElement {
  const slide = createDiv();
  slide.className = meta.slideCls;
  meta.fill(slide, meta.keyOf(d));
  return slide;
}

/** Shared level frame: pane > focus > track + three slides (prev/current/next).
    Weeks/months scroll vertically, days horizontally. */
export function renderCarousel(view: ViewHost, body: HTMLElement, meta: CarouselMeta): void {
  const pane = body.createDiv({ cls: meta.paneCls });
  const focus = pane.createDiv({ cls: meta.focusCls });
  const track = focus.createDiv({ cls: meta.trackCls });
  view.track = track;

  const cur = view.cursor;
  const slidePrev = createDiv();
  slidePrev.className = meta.slideCls;
  const slideCur = buildSlide(cur, meta);
  const slideNext = createDiv();
  slideNext.className = meta.slideCls;
  track.appendChild(slidePrev);
  track.appendChild(slideCur);
  track.appendChild(slideNext);

  const fillNeighbors = (): void => {
    meta.fill(slidePrev, meta.keyOf(meta.advance(cur, -1)));
    meta.fill(slideNext, meta.keyOf(meta.advance(cur, 1)));
  };
  if (!meta.lazyNeighbors) fillNeighbors();

  window.requestAnimationFrame(() => {
    if (!track.isConnected) return;
    if (meta.lazyNeighbors) fillNeighbors();
    resetTrack(view, track, meta);
  });

  view.resizeObserver?.disconnect();
  view.resizeObserver = new ResizeObserver(() => {
    if (view.track && view.track.isConnected) resetTrack(view, view.track, meta);
  });
  view.resizeObserver.observe(focus);
}

/** Centers the track. The base is the same for all levels — the second
    slide's center (1.5×slide) meets the focus center (0.5×focus):
    −0.895w for day, −0.85h for week, −h for month. */
export function resetTrack(view: ViewHost, track: HTMLElement, meta: CarouselMeta): void {
  if (view.carouselAnim) {
    view.carouselAnim.cancel();
    view.carouselAnim = null;
  }
  const focus = track.parentElement;
  if (!focus) return;
  const focusSize = meta.axis === "x" ? focus.clientWidth : focus.clientHeight;
  if (!focusSize) return;
  const slideSize = meta.slideRatio * focusSize;
  for (const slide of Array.from(track.children) as HTMLElement[]) {
    slide.classList.add("tv-no-grow");
    if (meta.axis === "x") slide.style.width = `${slideSize}px`;
    else slide.style.height = `${slideSize}px`;
  }
  const base = -(1.5 * slideSize - 0.5 * focusSize);
  track.style.transform = meta.axis === "x" ? `translateX(${base}px)` : `translateY(${base}px)`;
  void (meta.axis === "x" ? track.offsetWidth : track.offsetHeight); // reflow
}

/** Carousel step with a scroll animation. On cancel (fast paging) the track
    returns to the base — it never sticks or overlaps. */
export function carouselStep(view: ViewHost, dir: 1 | -1, meta: CarouselMeta): void {
  const track = view.track;
  if (!track) return;
  const focus = track.parentElement;
  if (!focus) return;
  const focusSize = meta.axis === "x" ? focus.clientWidth : focus.clientHeight;
  if (!focusSize) return;

  view.cursor = meta.advance(view.cursor, dir);

  // Reuse the slides, updating their content
  const slides = Array.from(track.children) as HTMLElement[];
  if (slides.length === 3) {
    meta.fill(slides[0], meta.keyOf(meta.advance(view.cursor, -1)));
    meta.fill(slides[1], meta.keyOf(view.cursor));
    meta.fill(slides[2], meta.keyOf(meta.advance(view.cursor, 1)));
  } else {
    track.replaceChildren(
      buildSlide(meta.advance(view.cursor, -1), meta),
      buildSlide(view.cursor, meta),
      buildSlide(meta.advance(view.cursor, 1), meta)
    );
  }

  const slideSize = meta.slideRatio * focusSize;
  for (const slide of Array.from(track.children) as HTMLElement[]) {
    slide.classList.add("tv-no-grow");
    if (meta.axis === "x") slide.style.width = `${slideSize}px`;
    else slide.style.height = `${slideSize}px`;
  }
  const base = -(1.5 * slideSize - 0.5 * focusSize);
  const start = base + (dir === 1 ? slideSize : -slideSize);
  const translate = meta.axis === "x" ? "translateX" : "translateY";

  if (view.carouselAnim) {
    view.carouselAnim.cancel();
    view.carouselAnim = null;
    track.style.transform = `${translate}(${base}px)`;
  }

  track.style.transform = `${translate}(${start}px)`;
  void (meta.axis === "x" ? track.offsetWidth : track.offsetHeight); // reflow

  const anim = track.animate(
    [
      { transform: `${translate}(${start}px)` },
      { transform: `${translate}(${base}px)` },
    ],
    { duration: meta.duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
  );
  anim.onfinish = () => {
    track.style.transform = `${translate}(${base}px)`;
  };
  view.carouselAnim = anim;
}
