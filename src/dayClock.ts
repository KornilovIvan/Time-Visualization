/**
 * Day-dial DOM. One SVG per day card: tick field, two task rings, a sweeping
 * now-needle with a short radar trail. The view calls paintDayClocks on a timer.
 */

import { formatDate } from "./parser";
import {
  CLOCK,
  CLOCK_MODES,
  arcPath,
  eventsForMode,
  faceCycle,
  formatHMS,
  handAngles,
  minutesOf,
  polar,
  sectorPath,
  shortLabel,
  spanIsPast,
  type ClockEvent,
  type ClockMode,
  type ClockTask,
} from "./clock";

const SVG_NS = "http://www.w3.org/2000/svg";
const GLOW_STEPS = 5;

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

let faceSeq = 0;

export function renderDayClock(
  host: HTMLElement,
  day: Date,
  tasks: readonly ClockTask[],
  mode: ClockMode,
  onMode: (mode: ClockMode) => void
): void {
  const key = formatDate(day);
  host.dataset.date = key;
  host.empty();
  hideClockTip();

  const cycle = faceCycle(mode);
  const events = eventsForMode(tasks, mode);
  const svg = svgEl("svg");
  svg.setAttribute("class", "tv-clock-face");
  svg.setAttribute("viewBox", `0 0 ${CLOCK.size} ${CLOCK.size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", mode === "24" ? "Day clock" : "Clock");
  svg.dataset.mode = mode;
  if (mode !== "24") svg.classList.add("is-analog");
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

  const showInner =
    mode !== "12" || events.some((event) => event.draws.some((draw) => draw.lane === 1));
  for (const radius of showInner ? [CLOCK.laneOuter, CLOCK.laneInner] : [CLOCK.laneOuter]) {
    const guide = svgEl("circle");
    guide.setAttribute("class", "tv-clock-guide");
    guide.setAttribute("cx", String(CLOCK.cx));
    guide.setAttribute("cy", String(CLOCK.cy));
    guide.setAttribute("r", String(radius));
    svg.appendChild(guide);
  }

  for (let minute = 0; minute < cycle; minute += 5) {
    const hour = minute % 60 === 0;
    const quarter = minute % 15 === 0;
    const inner = hour ? CLOCK.hourIn : quarter ? CLOCK.quarterIn : CLOCK.fiveIn;
    const [x0, y0] = polar(CLOCK.cx, CLOCK.cy, inner, minute, cycle);
    const [x1, y1] = polar(CLOCK.cx, CLOCK.cy, CLOCK.tickOut, minute, cycle);
    const tick = svgEl("line");
    tick.setAttribute("class", "tv-clock-tick" + (hour ? " is-hour" : quarter ? " is-quarter" : ""));
    tick.setAttribute("x1", x0.toFixed(2));
    tick.setAttribute("y1", y0.toFixed(2));
    tick.setAttribute("x2", x1.toFixed(2));
    tick.setAttribute("y2", y1.toFixed(2));
    svg.appendChild(tick);
  }

  if (mode === "24") {
    for (let hour = 0; hour < 24; hour += 3) {
      const [x, y] = polar(CLOCK.cx, CLOCK.cy, CLOCK.labelR, hour * 60, cycle);
      const label = svgEl("text");
      label.setAttribute("class", "tv-clock-label");
      label.setAttribute("x", x.toFixed(2));
      label.setAttribute("y", y.toFixed(2));
      label.textContent = String(hour).padStart(2, "0");
      svg.appendChild(label);
    }
  } else {
    for (let hour = 0; hour < 12; hour++) {
      const [x, y] = polar(CLOCK.cx, CLOCK.cy, CLOCK.labelR, hour * 60, cycle);
      const label = svgEl("text");
      label.setAttribute("class", "tv-clock-label");
      label.setAttribute("x", x.toFixed(2));
      label.setAttribute("y", y.toFixed(2));
      label.textContent = hour === 0 ? "12" : String(hour);
      svg.appendChild(label);
    }
  }

  const ordered = events.slice().sort((a, b) => b.lane - a.lane || a.start - b.start);
  for (const event of ordered) svg.appendChild(blockEl(event, cycle));

  const glow = svgEl("g");
  glow.setAttribute("class", "tv-clock-glow");
  for (let i = 0; i < GLOW_STEPS; i++) {
    const step = svgEl("path");
    step.setAttribute("class", "tv-clock-glow-step");
    step.dataset.step = String(i);
    glow.appendChild(step);
  }
  svg.appendChild(glow);

  svg.appendChild(dialHand("tv-clock-needle", CLOCK.needleIn, CLOCK.needleOut, true));
  svg.appendChild(hourHand());
  svg.appendChild(minuteHand());
  svg.appendChild(secondHand());
  svg.appendChild(pivot());

  const isToday = key === formatDate(new Date());
  const time = svgEl("text");
  time.setAttribute("class", "tv-clock-time");
  time.setAttribute("x", String(CLOCK.cx));
  time.setAttribute("y", String(CLOCK.cy - 36));
  time.textContent = isToday ? formatHMS(new Date()) : "";
  svg.appendChild(time);
  host.appendChild(svg);

  const modes = host.createDiv({ cls: "tv-clock-modes" });
  for (const [id, label] of CLOCK_MODES) {
    const btn = modes.createEl("button", {
      cls: "tv-clock-mode" + (id === mode ? " is-on" : ""),
      attr: { type: "button", "aria-pressed": id === mode ? "true" : "false" },
    });
    btn.setText(label);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onMode(id);
    });
  }
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

function dialHand(cls: string, inner: number, outer: number, tip: boolean): SVGGElement {
  const hand = svgEl("g");
  hand.setAttribute("class", cls);
  const line = svgEl("line");
  line.setAttribute("x1", String(CLOCK.cx));
  line.setAttribute("y1", String(CLOCK.cy - inner));
  line.setAttribute("x2", String(CLOCK.cx));
  line.setAttribute("y2", String(CLOCK.cy - outer));
  hand.appendChild(line);
  if (tip) {
    const dot = svgEl("circle");
    dot.setAttribute("cx", String(CLOCK.cx));
    dot.setAttribute("cy", String(CLOCK.cy - outer));
    dot.setAttribute("r", "2.4");
    hand.appendChild(dot);
  }
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
    const edgeR = radius + CLOCK.laneStroke / 2 - 0.4;
    const edge = svgEl("path");
    edge.setAttribute("class", "tv-clock-edge");
    edge.setAttribute("d", arcPath(CLOCK.cx, CLOCK.cy, edgeR, draw.start, draw.end, cycle));
    edge.setAttribute("stroke", event.color);
    group.appendChild(edge);

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
    const mode: ClockMode = svg.dataset.mode === "12" || svg.dataset.mode === "rows" ? svg.dataset.mode : "24";
    const analog = mode !== "24";
    const cycle = faceCycle(mode);
    const needle = svg.querySelector(".tv-clock-needle");
    const hourEl = svg.querySelector(".tv-clock-hour");
    const minuteEl = svg.querySelector(".tv-clock-minute");
    const secondEl = svg.querySelector(".tv-clock-second");
    const boss = svg.querySelector(".tv-clock-boss-wrap");
    const glow = svg.querySelector(".tv-clock-glow");
    needle?.classList.toggle("is-hidden", !isToday || analog);
    hourEl?.classList.toggle("is-hidden", !isToday || !analog);
    minuteEl?.classList.toggle("is-hidden", !isToday || !analog);
    secondEl?.classList.toggle("is-hidden", !isToday || !analog);
    boss?.classList.toggle("is-hidden", !isToday || !analog);
    glow?.classList.toggle("is-hidden", !isToday);
    if (isToday && !analog && needle) {
      const deg = (nowMin / 1440) * 360;
      needle.setAttribute("transform", `rotate(${deg.toFixed(3)} ${CLOCK.cx} ${CLOCK.cy})`);
    }
    if (isToday && analog) {
      const angles = handAngles(now);
      const turn = (el: Element | null, deg: number): void => {
        el?.setAttribute("transform", `rotate(${deg.toFixed(3)} ${CLOCK.cx} ${CLOCK.cy})`);
      };
      turn(hourEl, angles.hour);
      turn(minuteEl, angles.minute);
      turn(secondEl, angles.second);
    }
    if (isToday && glow) {
      const faceNow = analog ? nowMin % cycle : nowMin;
      const tail = CLOCK.glowTail * (cycle / 1440);
      const morning = nowMin % 1440 < 720;
      const glowRadius = mode === "rows" ? (morning ? CLOCK.laneInner : CLOCK.laneOuter) : 0;
      const r0 = mode === "rows" ? glowRadius - 10 : CLOCK.glowIn;
      const r1 = mode === "rows" ? glowRadius + 10 : CLOCK.glowOut;
      const steps = glow.querySelectorAll<SVGPathElement>(".tv-clock-glow-step");
      steps.forEach((step, i) => {
        const from = faceNow - tail * (1 - i / GLOW_STEPS);
        const to = faceNow - tail * (1 - (i + 1) / GLOW_STEPS);
        step.setAttribute("d", sectorPath(CLOCK.cx, CLOCK.cy, r0, r1, from, to, cycle));
        step.setAttribute("opacity", (0.04 + (i / (GLOW_STEPS - 1)) * 0.22).toFixed(3));
      });
    }

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
