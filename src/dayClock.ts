/**
 * Day-dial DOM. One SVG per day card: tick field, task rings, and a red
 * stripe at the current time. The view calls paintDayClocks on a timer.
 */

import { formatDate } from "./parser";
import {
  CLOCK,
  FACE_CYCLE,
  arcPath,
  eventsForClock,
  formatHMS,
  handAngles,
  minutesOf,
  polar,
  shortLabel,
  spanIsPast,
  type ClockEvent,
  type ClockTask,
} from "./clock";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

/** Stripe across the ring of the current half-day. */
function nowRadii(nowMin: number): { stemIn: number; stemOut: number } {
  const edge = CLOCK.laneStroke / 2 + 2;
  const ring = nowMin % 1440 < 720 ? CLOCK.laneInner : CLOCK.laneOuter;
  return { stemIn: ring - edge, stemOut: ring + edge };
}

function nowMarkEl(): SVGGElement {
  const group = svgEl("g");
  group.setAttribute("class", "tv-clock-now");
  const stemHalo = svgEl("line");
  stemHalo.setAttribute("class", "tv-clock-now-stem-halo");
  const stem = svgEl("line");
  stem.setAttribute("class", "tv-clock-now-stem");
  group.appendChild(stemHalo);
  group.appendChild(stem);
  return group;
}

function placeNowMark(mark: Element, nowMin: number): void {
  const faceNow = nowMin % FACE_CYCLE;
  const { stemIn, stemOut } = nowRadii(nowMin);
  const [x0, y0] = polar(CLOCK.cx, CLOCK.cy, stemIn, faceNow, FACE_CYCLE);
  const [x1, y1] = polar(CLOCK.cx, CLOCK.cy, stemOut, faceNow, FACE_CYCLE);
  for (const selector of [".tv-clock-now-stem-halo", ".tv-clock-now-stem"]) {
    const line = mark.querySelector(selector);
    line?.setAttribute("x1", x0.toFixed(2));
    line?.setAttribute("y1", y0.toFixed(2));
    line?.setAttribute("x2", x1.toFixed(2));
    line?.setAttribute("y2", y1.toFixed(2));
  }
}

let faceSeq = 0;

export function renderDayClock(
  host: HTMLElement,
  day: Date,
  tasks: readonly ClockTask[]
): void {
  const key = formatDate(day);
  host.dataset.date = key;
  host.empty();
  hideClockTip();

  const events = eventsForClock(tasks);
  const svg = svgEl("svg");
  svg.setAttribute("class", "tv-clock-face");
  svg.setAttribute("viewBox", `0 0 ${CLOCK.size} ${CLOCK.size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Clock");
  const gradId = `tv-dial-${++faceSeq}`;

  const defs = svgEl("defs");
  const grad = svgEl("radialGradient");
  grad.id = gradId;
  grad.setAttribute("cx", "50%");
  grad.setAttribute("cy", "42%");
  grad.setAttribute("r", "62%");
  for (const [offset, color] of [
    ["0%", "var(--background-primary)"],
    ["72%", "var(--background-secondary)"],
    ["100%", "var(--background-modifier-border)"],
  ] as const) {
    const stop = svgEl("stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  const disc = svgEl("circle");
  disc.setAttribute("class", "tv-clock-disc");
  disc.setAttribute("cx", String(CLOCK.cx));
  disc.setAttribute("cy", String(CLOCK.cy));
  disc.setAttribute("r", String(CLOCK.tickOut));
  disc.setAttribute("fill", `url(#${gradId})`);
  svg.appendChild(disc);

  for (const radius of [CLOCK.laneOuter, CLOCK.laneInner]) {
    const guide = svgEl("circle");
    guide.setAttribute("class", "tv-clock-guide");
    guide.setAttribute("cx", String(CLOCK.cx));
    guide.setAttribute("cy", String(CLOCK.cy));
    guide.setAttribute("r", String(radius));
    svg.appendChild(guide);
  }

  for (let minute = 0; minute < FACE_CYCLE; minute += 5) {
    const hour = minute % 60 === 0;
    const quarter = minute % 15 === 0;
    const inner = hour ? CLOCK.hourIn : quarter ? CLOCK.quarterIn : CLOCK.fiveIn;
    const [x0, y0] = polar(CLOCK.cx, CLOCK.cy, inner, minute, FACE_CYCLE);
    const [x1, y1] = polar(CLOCK.cx, CLOCK.cy, CLOCK.tickOut, minute, FACE_CYCLE);
    const tick = svgEl("line");
    tick.setAttribute("class", "tv-clock-tick" + (hour ? " is-hour" : quarter ? " is-quarter" : ""));
    tick.setAttribute("x1", x0.toFixed(2));
    tick.setAttribute("y1", y0.toFixed(2));
    tick.setAttribute("x2", x1.toFixed(2));
    tick.setAttribute("y2", y1.toFixed(2));
    svg.appendChild(tick);
  }

  for (let hour = 0; hour < 12; hour++) {
    const [x, y] = polar(CLOCK.cx, CLOCK.cy, CLOCK.labelR, hour * 60, FACE_CYCLE);
    const label = svgEl("text");
    label.setAttribute("class", "tv-clock-label");
    label.setAttribute("x", x.toFixed(2));
    label.setAttribute("y", y.toFixed(2));
    label.textContent = hour === 0 ? "12" : String(hour);
    svg.appendChild(label);
  }

  const ordered = events.slice().sort((a, b) => b.lane - a.lane || a.start - b.start);
  for (const event of ordered) svg.appendChild(blockEl(event, FACE_CYCLE));

  const nowMark = nowMarkEl();
  const drawnAt = new Date();
  if (key === formatDate(drawnAt)) placeNowMark(nowMark, minutesOf(drawnAt));
  else nowMark.classList.add("is-hidden");
  svg.appendChild(nowMark);

  const isToday = key === formatDate(new Date());
  const time = svgEl("text");
  time.setAttribute("class", "tv-clock-time");
  time.setAttribute("x", String(CLOCK.cx));
  time.setAttribute("y", String(CLOCK.cy - 36));
  time.textContent = isToday ? formatHMS(new Date()) : "";
  svg.appendChild(time);

  svg.appendChild(hourHand());
  svg.appendChild(minuteHand());
  svg.appendChild(secondHand());
  svg.appendChild(pivot());
  host.appendChild(svg);
  paintDayClocks(host);
}

/** Short wide hour hand, with a small tail past the pivot. Points at 12 until rotated. */
function hourHand(): SVGGElement {
  const { cx, cy } = CLOCK;
  return shapedHand("tv-clock-hour", [
    [cx, cy - 76],
    [cx + 5.6, cy - 18],
    [cx + 2.5, cy + 18],
    [cx - 2.5, cy + 18],
    [cx - 5.6, cy - 18],
  ]);
}

/** Long narrow minute hand. Reaches the task ring; the hour hand stays in the hub. */
function minuteHand(): SVGGElement {
  const { cx, cy } = CLOCK;
  return shapedHand("tv-clock-minute", [
    [cx, cy - 150],
    [cx + 2.5, cy - 24],
    [cx + 1.35, cy + 24],
    [cx - 1.35, cy + 24],
    [cx - 2.5, cy - 24],
  ]);
}

/** Thin second hand: a counterweight, a ring, and a tip that sweeps the ticks. */
function secondHand(): SVGGElement {
  const { cx, cy } = CLOCK;
  const hand = svgEl("g");
  hand.setAttribute("class", "tv-clock-second");
  const line = svgEl("line");
  line.setAttribute("x1", String(cx));
  line.setAttribute("y1", String(cy + 34));
  line.setAttribute("x2", String(cx));
  line.setAttribute("y2", String(cy - 160));
  const bob = svgEl("circle");
  bob.setAttribute("class", "tv-clock-second-bob");
  bob.setAttribute("cx", String(cx));
  bob.setAttribute("cy", String(cy + 26));
  bob.setAttribute("r", "3.6");
  const eye = svgEl("circle");
  eye.setAttribute("class", "tv-clock-second-eye");
  eye.setAttribute("cx", String(cx));
  eye.setAttribute("cy", String(cy - 118));
  eye.setAttribute("r", "4.2");
  hand.appendChild(line);
  hand.appendChild(bob);
  hand.appendChild(eye);
  return hand;
}

function pivot(): SVGGElement {
  const { cx, cy } = CLOCK;
  const wrap = svgEl("g");
  wrap.setAttribute("class", "tv-clock-boss-wrap");
  const boss = svgEl("circle");
  boss.setAttribute("class", "tv-clock-boss");
  boss.setAttribute("cx", String(cx));
  boss.setAttribute("cy", String(cy));
  boss.setAttribute("r", "7.2");
  const pin = svgEl("circle");
  pin.setAttribute("class", "tv-clock-boss-pin");
  pin.setAttribute("cx", String(cx));
  pin.setAttribute("cy", String(cy));
  pin.setAttribute("r", "2.5");
  wrap.appendChild(boss);
  wrap.appendChild(pin);
  return wrap;
}

function shapedHand(cls: string, points: Array<[number, number]>): SVGGElement {
  const hand = svgEl("g");
  hand.setAttribute("class", cls);
  const poly = svgEl("polygon");
  poly.setAttribute("class", cls + "-shape");
  poly.setAttribute("points", points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
  hand.appendChild(poly);
  return hand;
}

function blockEl(event: ClockEvent, cycle: number): SVGGElement {
  const group = svgEl("g");
  group.setAttribute("class", "tv-clock-block" + (event.ranged ? "" : " is-point") + (event.done ? " is-done" : ""));
  group.dataset.start = String(event.start);
  group.dataset.end = String(event.end);
  group.dataset.label = shortLabel(event.label);
  group.dataset.when = event.timeLabel.replace(/\s*[-–—]\s*/g, "–");

  for (const draw of event.draws) {
    const radius = draw.lane === 1 ? CLOCK.laneInner : CLOCK.laneOuter;
    const arc = svgEl("path");
    arc.setAttribute("class", "tv-clock-arc");
    arc.setAttribute("d", arcPath(CLOCK.cx, CLOCK.cy, radius, draw.start, draw.end, cycle));
    arc.setAttribute("stroke", event.color);
    group.appendChild(arc);
  }

  const title = svgEl("title");
  title.textContent = `${group.dataset.when} ${event.label}`.trim();
  group.appendChild(title);

  const tipText = `${group.dataset.when} ${group.dataset.label}`.trim();
  const showTip = (ev: PointerEvent): void => {
    group.classList.add("is-hot");
    placeClockTip(tipText, ev.clientX, ev.clientY);
  };
  group.addEventListener("pointerover", showTip);
  group.addEventListener("pointermove", showTip);
  group.addEventListener("pointerout", (ev) => {
    const next = ev.relatedTarget;
    if (next instanceof Node && group.contains(next)) return;
    group.classList.remove("is-hot");
    hideClockTip();
  });
  return group;
}

function placeClockTip(text: string, x: number, y: number): void {
  let tip = document.body.querySelector<HTMLElement>(".tv-clock-tip");
  if (!tip) tip = document.body.createDiv({ cls: "tv-clock-tip" });
  tip.setText(text);
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 16}px`;
}

function hideClockTip(): void {
  document.body.querySelector(".tv-clock-tip")?.remove();
}

function clockNodes(root: ParentNode): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.classList.contains("tv-day-clock")) nodes.push(root);
  root.querySelectorAll<HTMLElement>(".tv-day-clock").forEach((node) => nodes.push(node));
  return nodes;
}

/** Move the now-needle and dim arcs that have already ended. Safe to call often. */
export function paintDayClocks(root: ParentNode, now = new Date()): void {
  const today = formatDate(now);
  const nowMin = minutesOf(now);
  const minute = Math.floor(nowMin);
  for (const host of clockNodes(root)) {
    const svg = host.querySelector("svg");
    if (!svg) continue;
    const isToday = host.dataset.date === today;
    const dayKey = host.dataset.date ?? "";
    const hourEl = svg.querySelector(".tv-clock-hour");
    const minuteEl = svg.querySelector(".tv-clock-minute");
    const secondEl = svg.querySelector(".tv-clock-second");
    const boss = svg.querySelector(".tv-clock-boss-wrap");
    const nowMark = svg.querySelector(".tv-clock-now");
    hourEl?.classList.toggle("is-hidden", !isToday);
    minuteEl?.classList.toggle("is-hidden", !isToday);
    secondEl?.classList.toggle("is-hidden", !isToday);
    boss?.classList.toggle("is-hidden", !isToday);
    nowMark?.classList.toggle("is-hidden", !isToday);
    if (isToday) {
      const angles = handAngles(now);
      const turn = (el: Element | null, deg: number): void => {
        el?.setAttribute("transform", `rotate(${deg.toFixed(3)} ${CLOCK.cx} ${CLOCK.cy})`);
      };
      turn(hourEl, angles.hour);
      turn(minuteEl, angles.minute);
      turn(secondEl, angles.second);
    }
    if (isToday && nowMark) placeNowMark(nowMark, nowMin);

    if (host.dataset.paintedMinute !== String(minute) || host.dataset.paintedDay !== today) {
      host.dataset.paintedMinute = String(minute);
      host.dataset.paintedDay = today;
      const allPast = dayKey < today;
      const allFuture = dayKey > today;
      svg.querySelectorAll<SVGGElement>(".tv-clock-block").forEach((block) => {
        const start = Number(block.dataset.start);
        const end = Number(block.dataset.end);
        const past = allPast || (isToday && spanIsPast(start, end, nowMin));
        block.classList.toggle("is-past", past && !allFuture);
      });
    }
    const second = String(now.getSeconds());
    if (isToday && host.dataset.paintedSecond !== second) {
      host.dataset.paintedSecond = second;
      const time = svg.querySelector(".tv-clock-time");
      if (time) time.textContent = formatHMS(now);
    }
  }
}
