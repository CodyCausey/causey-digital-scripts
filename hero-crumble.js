(function () {
  "use strict";

  var root = document.documentElement;
  function release() { root.classList.remove("js-intro"); }

  function init() {
    if (root.hasAttribute("data-hero-crumble")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { release(); return; }

    const $ = (id) => document.getElementById(id);
    const track = $("heroTrack");
    const pin = $("heroPin");
    const hero = $("hero");
    const markEl = $("heroMark");
    const markSvg = $("heroMarkSvg");
    const valueEl = $("value");
    const heading = $("heroHeading");

    const required = { heroTrack: track, heroPin: pin, hero, heroMark: markEl, heroMarkSvg: markSvg, value: valueEl, heroHeading: heading };
    const missing = Object.keys(required).filter((k) => !required[k]);
    if (
      missing.length ||
      !track.contains(pin) ||
      !pin.contains(hero) ||
      !pin.contains(valueEl)
    ) {
      console.warn(
        "Hero crumble not started. " +
          (missing.length
            ? "Missing ids: " + missing.join(", ") + "."
            : "Expected #heroTrack > #heroPin > #hero + #value.")
      );
      release();
      return;
    }
    root.setAttribute("data-hero-crumble", "");

    // Overlays the script owns: a canvas in the hero, a canvas over the pin, and the tagline's flying square.
    function overlay(tag, id, parent, css, atStart) {
      let el = $(id);
      if (!el) {
        el = document.createElement(tag);
        el.id = id;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = css;
        if (atStart) parent.insertBefore(el, parent.firstChild);
        else parent.appendChild(el);
      }
      return el;
    }
    const canvas = overlay("canvas", "heroCanvas", hero, "position:absolute;inset:0;width:100%;height:100%;pointer-events:none", true);
    const pinCanvas = overlay("canvas", "heroPinCanvas", pin, "position:absolute;inset:0;z-index:3;width:100%;height:100%;pointer-events:none", true);
    const popEl = overlay("div", "heroPop", pin, "position:absolute;left:0;top:0;z-index:3;visibility:hidden;pointer-events:none", false);
    const ctx = canvas.getContext("2d");
    const pctx = pinCanvas.getContext("2d");

    const bullets = [...valueEl.querySelectorAll(".proto-value_pixel")];
    const headingText = heading.textContent.trim().replace(/\s+/g, " ");
    const headingHTML = heading.innerHTML; // put back once the slide is done, so markup built in Webflow survives
    // No tagline square (or hidden with the meta lines): a detached stand-in has no box, so the pop never plays
    const tagPixel = $("tagPixel") || document.createElement("div");
    const navbar = document.querySelector(".proto-section_navbar");

    // Tune these two by eye
    const HEAL_DELAY_MS = 500; // how long the page has to sit still before a broken mark rebuilds itself
    const HEAL_SPEED = 0.4; // rebuild pace: 1 = the load build's pace; 2 = twice as fast

    const FRAME_W = 884,
      FRAME_H = 793; // the mark's viewBox
    const UNIT = 22; // square size in mark units
    const INTRO_MS = 2200; // build-in length
    const SMOOTHING = 5; // scroll easing rate per second
    const MAX_DT = 0.05; // longest frame step the easing takes, seconds
    const FIRST_DT = 1 / 60; // step for the first frame after the loop restarts
    const THROW = 0.2; // erode progress a thrown square takes to reach its bullet
    const THROW_START = 0.16,
      THROW_STAGGER = 0.05; // when the thrown squares let go, left bullet first
    const BUMP = 0.035; // erode progress the bullet's landing bump lasts
    const LAND_MARGIN = 32; // px of screen below a bullet before it counts as in view
    const LAND_AFTER = 0.03; // erode progress after a bullet comes into view before its square lands
    const LAND_STAGGER = 0.015; // erode progress between one square landing and the next
    const LAND_LAST = 0.95; // the last square lands by here, whatever the screen size
    const POP_AFTER_MS = 200; // the tagline square pops this long after the H1 starts coming out
    const POP_MS = 520,
      POP_BUMP_MS = 110; // its flight and landing bump
    const HEADING_MS = 750,
      HEADING_STAGGER_MS = 60; // keep in step with #heroHeading.hero-js-out in the footer style block
    const HEADING_OPEN_MS = 450; // where a resting line runs under the mark, the clip then opens to show the rest
    const MELT = 0.06; // erode progress over which the finished mark fades in over the squares
    const MELT_SCROLL = 0.02; // the same at the start of the scroll erode
    const LEAD = 0.05,
      LEAD_SCROLL = 0.02; // erode progress over which a square sinks and tilts before letting go (build, scroll)
    const BUILD_LOOSEN = 0.3; // how much the squares sink and tilt as they land in the build
    const SEAM_FRONT = 0.02; // scroll erode: a square's gaps open over this much progress just before it comes loose
    let headingAt = 0.02; // the H1 comes out when the last square of the build lands (set in buildCells)
    const RELEASE_AT = 0.5; // share of the scroll erode done while the hero is pinned
    const HEAL_MIN_P = 0.02; // self-heal only once the erode has really started...
    const HEAL_MIN_SHOWN = 0.5; // ...and only while at least this share of the mark is on screen below the navbar
    const KEPT_FADE = 0.08; // a kept bullet square's copy in the mark fades over this much erode
    // Outer edge of the C (the two outer curves of mark-c), top end to bottom end, mark units
    const C_EDGE = [
      [[377.702, 0.013], [153.413, 1.365], [0, 158.249], [0, 389.376]],
      [[0, 389.376], [0, 622.752], [146.016, 783.744], [378.144, 783.744]],
    ];

    let headingState = "rest",
      headingTimer = 0,
      headingGuard = 0,
      headingOpenClip = ""; // 'rest' | 'pre' (hidden in the mark) | 'out' (sliding)
    let popCell = null,
      popTarget = null,
      popPath = null,
      popState = "off",
      popStart = 0,
      popAt = 0; // 'off' | 'wait' (tagline empty) | 'fly'

    let W, H, PW, PH, heroY, dpr, scaleX, scaleY, originX, originY;
    // The mark's top-left in the hero canvas's device pixels: whole part (where squares are copied) and fraction
    let oDx = 0,
      oDy = 0,
      fracX = 0,
      fracY = 0;
    let scrollable = false, // the pin is sticky and the track has scroll left (set in layout)
      warnedPin = false,
      warnedBox = false;
    let offscreen = null,
      cells = [],
      thrown = [],
      targets = [],
      cellPx = 0,
      ready = false,
      active = false; // active: the mark has a box at this width
    let loosen = 1,
      headed = false,
      lastP = -1,
      smoothP = 0,
      introStart = 0,
      introActive = false,
      scrollFrom = 0;
    // Scroll measurements, cached in measureScroll() so the frame loop and the scroll handler only read scrollY
    let pinTop = 0,
      scrollDist = 0,
      trackY = 0,
      pinSticky = true,
      lineTop = 0;
    // Last values written, so styles are only touched (and canvases only cleared) when something changed
    let heroDirty = false,
      pinDirty = false,
      markVis = null,
      markOpacity = null;
    const bulletVis = [],
      bulletTf = [];
    // Self-heal: plays the erode backwards from where the mark was, on the load build's curve
    let healing = false,
      healT0 = 0,
      healStart = 0,
      healY = 0,
      healTimer = 0;
    const kept = new Set(); // bullets (by throw index) held filled; a heal clears it so their squares fly home too

    // Seeded random so each square behaves the same on every pass
    function rng(seed) {
      return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
    const smoothstep = (t) => t * t * (3 - 2 * t);

    function layout() {
      // The value row's height, for a wide-screen hero height rule in Webflow styles (nothing reads it unless a style does)
      root.style.setProperty("--value-row-height", valueEl.offsetHeight + "px");
      W = hero.clientWidth;
      H = hero.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      measureScroll();

      // Runs only where the mark has a box (Webflow hides it below Tablet) and the pin is sticky with track left to
      // scroll. Anywhere else the page parks static; a resize re-checks
      const art = markSvg.querySelector("svg");
      const ar = art ? art.getBoundingClientRect() : null;
      const shown = !!ar && ar.width > 1 && ar.height > 1 && W > 0 && H > 0;
      scrollable = pinSticky && scrollDist > 0;
      if (shown && !scrollable && !warnedPin) {
        warnedPin = true;
        console.warn("Hero crumble parked: the mark shows but #heroPin isn't sticky or #heroTrack has no scroll at this width.");
      }
      // Where Webflow actually put the mark: the SVG's own matrix from mark units (viewBox) to screen px, so the mark
      // box's padding and any stretch are included, per axis
      const m = shown && scrollable ? art.getScreenCTM() : null;
      active = !!m && m.a > 0 && m.d > 0;
      if (!active) return;
      const vb = art.viewBox && art.viewBox.baseVal;
      if (!warnedBox && vb && vb.width && (vb.x || vb.y || vb.width !== FRAME_W || vb.height !== FRAME_H)) {
        warnedBox = true;
        console.warn("Hero crumble: the mark's viewBox should be 0 0 " + FRAME_W + " " + FRAME_H + ", so the squares will be cut wrong.");
      }
      const hr = hero.getBoundingClientRect(),
        pr = pin.getBoundingClientRect();
      scaleX = m.a;
      scaleY = m.d;
      originX = m.e - hr.left;
      originY = m.f - hr.top;
      heroY = hr.top - pr.top;
      // The same point in the hero canvas's device pixels, assuming the browser snaps the canvas to whole device
      // pixels. The fraction goes into drawMark so whole-pixel copies land on the DOM mark's sub-pixel position.
      // Worked out for the hero as it sits while pinned (the pin at its sticky top), where the swaps happen
      const heroTop = pinTop + heroY;
      const devX = m.e * dpr - Math.round(hr.left * dpr),
        devY = (heroTop + originY) * dpr - Math.round(heroTop * dpr);
      oDx = Math.floor(devX);
      oDy = Math.floor(devY);
      fracX = devX - oDx;
      fracY = devY - oDy;

      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);

      // The pin canvas covers the hero and the value row; bullet centres are measured in its space
      PW = pin.clientWidth;
      PH = pin.clientHeight;
      pinCanvas.width = Math.round(PW * dpr);
      pinCanvas.height = Math.round(PH * dpr);
      heroDirty = pinDirty = false; // resizing a canvas clears it
      targets = bullets.map((b, i) => {
        b.style.transform = bulletTf[i] = "";
        const r = b.getBoundingClientRect();
        return { x: r.left - pr.left + r.width / 2, y: r.top - pr.top + r.height / 2, s: r.width };
      });
      // The tagline square, in the same space (no box when the meta lines are hidden, so no pop there)
      tagPixel.style.transform = "";
      const tr = tagPixel.getBoundingClientRect();
      popTarget = tr.width
        ? { x: tr.left - pr.left + tr.width / 2, y: tr.top - pr.top + tr.height / 2, s: tr.width }
        : null;
      if (popTarget) {
        // The flying square takes the tagline square's own size and colour
        popEl.style.width = popEl.style.height = popTarget.s + "px";
        popEl.style.background = getComputedStyle(tagPixel).backgroundColor;
      }
    }

    // Where the sticky track sits on the page and how far it scrolls. Re-run on every layout and whenever the
    // pin or the track changes size, so everything per frame can be worked out from scrollY alone
    function measureScroll() {
      const cs = getComputedStyle(pin);
      pinSticky = cs.position === "sticky";
      pinTop = pinSticky ? parseFloat(cs.top) || 0 : 0;
      trackY = track.getBoundingClientRect().top + scrollY;
      scrollDist = track.offsetHeight - pin.offsetHeight;
      lineTop = pinTop || (navbar ? navbar.offsetHeight : 0);
    }

    // The pin's top in the viewport at scroll position y: where it would sit in the flow, held at its sticky top
    // until the track runs out
    function pinViewTop(y) {
      const natural = trackY - y;
      return pinSticky ? Math.min(Math.max(natural, pinTop), natural + scrollDist) : natural;
    }

    // Paint the mark into an offscreen canvas from the inline SVG paths
    function drawMark() {
      const kx = scaleX * dpr,
        ky = scaleY * dpr;
      offscreen = document.createElement("canvas");
      offscreen.width = Math.ceil(FRAME_W * kx) + 1;
      offscreen.height = Math.ceil(FRAME_H * ky) + 1;
      const o = offscreen.getContext("2d");
      // Drawn at the mark's sub-pixel offset, so the copy matches the DOM mark at the swap (no seam or shimmer)
      o.setTransform(kx, 0, 0, ky, fracX, fracY);
      for (const path of markSvg.querySelectorAll("path")) {
        o.fillStyle = path.getAttribute("fill");
        o.fill(new Path2D(path.getAttribute("d")));
      }
    }

    function buildCells() {
      const kx = scaleX * dpr,
        ky = scaleY * dpr;
      cellPx = (UNIT * (scaleX + scaleY)) / 2;
      const cols = Math.ceil(FRAME_W / UNIT),
        rows = Math.ceil(FRAME_H / UNIT);
      const ow = offscreen.width,
        oh = offscreen.height;
      // Square edges in whole device pixels, offset like the copy; neighbours share edges, so nothing overlaps or
      // gaps. The outer edges take in the whole offscreen copy
      const edges = (n, k, frac, end) =>
        Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : i === n ? end : Math.round(i * UNIT * k + frac)));
      const ex = edges(cols, kx, fracX, ow),
        ey = edges(rows, ky, fracY, oh);
      const img = offscreen.getContext("2d").getImageData(0, 0, ow, oh).data;
      const filled = (c, r) => {
        for (let y = ey[r]; y < ey[r + 1] && y < oh; y++)
          for (let x = ex[c]; x < ex[c + 1] && x < ow; x++)
            if (img[(y * ow + x) * 4 + 3] > 0) return true;
        return false;
      };

      const grid = [];
      cells = [];
      const rand = rng(1337);
      for (let r = 0; r < rows; r++) {
        grid[r] = [];
        for (let c = 0; c < cols; c++) {
          const sw = ex[c + 1] - ex[c],
            sh = ey[r + 1] - ey[r];
          if ((oDx + ex[c]) / dpr > W || sw <= 0 || sh <= 0 || !filled(c, r)) {
            grid[r][c] = null;
            continue;
          }
          const cell = {
            c,
            r,
            sx: ex[c],
            sy: ey[r],
            sw,
            sh,
            x0: (oDx + ex[c] + sw / 2) / dpr,
            y0: (oDy + ey[r] + sh / 2) / dpr, // resting centre, CSS px
            u: c / cols,
            r1: rand(),
            r2: rand(),
            r3: rand(),
          };
          grid[r][c] = cell;
          cells.push(cell);
        }
      }

      // Depth from the outside edge (breadth-first): outer layers erode first, and land first in the build
      const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const q = [];
      let maxD = 0;
      for (const cell of cells) {
        const edge = NEIGHBOURS.some(([dc, dr]) => !grid[cell.r + dr] || !grid[cell.r + dr][cell.c + dc]);
        cell.depth = edge ? 0 : Infinity;
        if (edge) q.push(cell);
      }
      for (let i = 0; i < q.length; i++) {
        const cell = q[i];
        for (const [dc, dr] of NEIGHBOURS) {
          const nb = grid[cell.r + dr] && grid[cell.r + dr][cell.c + dc];
          if (nb && nb.depth > cell.depth + 1) {
            nb.depth = cell.depth + 1;
            maxD = Math.max(maxD, nb.depth);
            q.push(nb);
          }
        }
      }
      for (const cell of cells) {
        const dd = cell.depth / (maxD || 1);
        // Starts at LEAD_SCROLL, so the outer edge starts to go within the first few px of scroll
        cell.d = cell.dCrumble = LEAD_SCROLL + dd * 0.38 + cell.r1 * 0.14;
        // The build-in mirrors it: the outside edge lands first and the middle fills last
        cell.dBuild = 0.06 + (1 - dd) * 0.38 + cell.r1 * 0.05;
      }

      // The logo reads as built once its last square lands: the H1 comes out right then
      headingAt = Math.min(...cells.map((cell) => cell.dBuild));

      // Thrown squares: interior squares of the orange block, spread across it, left ones to the left bullets
      const isOrange = (cell) => {
        const i = ((cell.sy + (cell.sh >> 1)) * ow + cell.sx + (cell.sw >> 1)) * 4;
        return img[i] > 200 && img[i + 1] < 120 && img[i + 2] < 60 && img[i + 3] === 255;
      };
      // The square that pops off onto the tagline: the orange block's bottom-left corner
      popCell = null;
      for (const cell of cells) {
        if (isOrange(cell) && (!popCell || cell.c < popCell.c || (cell.c === popCell.c && cell.r > popCell.r)))
          popCell = cell;
      }

      const orange = cells.filter((cell) => cell.depth >= 1 && isOrange(cell));
      const n = Math.min(bullets.length, orange.length);
      thrown = Array.from({ length: n }, (_, i) => orange[Math.floor(((i + 0.5) * orange.length) / n)]).sort(
        (a, b) => a.c - b.c || a.r - b.r
      );
      thrown.forEach((cell, i) => {
        cell.throw = i;
        // dIntro: the build-in's timing. dLand: when scrolling throws them down, set by scheduleLanding
        // dCrumble: its plain crumble timing, used once its bullet is kept
        cell.dCrumble = cell.d;
        cell.d = cell.dIntro = cell.dLand = THROW_START + i * THROW_STAGGER;
      });
    }

    // On most laptop screens the bullet row is below the fold while the hero is pinned, so a square thrown at its
    // usual time would land unseen. Each thrown square waits until its bullet has scrolled into view, then lands
    // just after. Screens tall enough to show the bullets while pinned keep the original timing
    function scheduleLanding() {
      const dist = scrollDist;
      const perPx = dist > 0 ? RELEASE_AT / dist : 0; // erode progress per px of scroll
      for (const cell of thrown) {
        const i = cell.throw,
          tg = targets[i];
        let land = cell.dIntro + THROW;
        const below = pinTop + tg.y + tg.s / 2 + LAND_MARGIN - innerHeight; // px the bullet sits below the screen while pinned
        if (perPx && below > 0) land = Math.max(land, (dist + below) * perPx + LAND_AFTER + i * LAND_STAGGER);
        cell.dLand = Math.max(cell.dIntro, Math.min(land, LAND_LAST) - THROW);
      }
    }

    // Square centre (CSS px, hero space) and rotation at erode progress p
    function place(cell, p) {
      const t = p - cell.d;
      const lead = introActive ? LEAD : LEAD_SCROLL;
      if (t <= -lead) return [cell.x0, cell.y0, 0];
      // Loosen: just before letting go the square sinks and tilts a touch
      const lo = Math.pow(clamp(1 + t / lead), 2) * loosen;
      const dx = lo * (cell.r2 - 0.5) * cellPx * 0.12;
      const dy = lo * cellPx * 0.1;
      const tilt = lo * (cell.r3 - 0.5) * 0.3;
      if (t <= 0) return [cell.x0 + dx, cell.y0 + dy, tilt];
      const T = t / 0.42;
      const g = H * 1.6;
      const side = (cell.u - 0.45) * cellPx * 10;
      return [
        cell.x0 + dx + side * T + (cell.r2 - 0.5) * cellPx * 6 * T,
        cell.y0 + dy - cellPx * 1.2 * cell.r3 * T + g * T * T,
        tilt + (cell.r3 - 0.5) * 9 * T,
      ];
    }

    // A thrown square's centre (pin space), rotation and size: a hop up, then an arc down onto its bullet
    function throwPlace(cell, p) {
      const T = clamp((p - cell.d) / THROW);
      const e = smoothstep(T);
      const [x1, hy1, tilt] = place(cell, cell.d);
      const y1 = hy1 + heroY;
      const tg = targets[cell.throw];
      const arc = cellPx * 4 + Math.abs(tg.x - x1) * 0.15;
      const spin = (cell.r2 < 0.5 ? -1 : 1) * Math.PI; // a half turn, so it lands square
      return [
        x1 + (tg.x - x1) * e,
        y1 + (tg.y - y1) * T * T - arc * 4 * T * (1 - T),
        tilt * (1 - T) + spin * e,
        cellPx + (tg.s - cellPx) * e,
      ];
    }

    function render(p, throwing) {
      // Only clear when the last frame drew something
      if (heroDirty) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        heroDirty = false;
      }
      renderThrown(p, throwing);
      // At rest the real DOM mark shows. Near rest it fades in over the canvas copy, so the last squares and the
      // hairline gaps melt into the finished mark instead of snapping shut (and the reverse as the erode starts)
      const solid = 1 - smoothstep(clamp(p / (introActive ? MELT : MELT_SCROLL)));
      const vis = solid > 0 ? "visible" : "hidden",
        op = solid < 1 ? solid.toFixed(3) : "";
      if (vis !== markVis) markEl.style.visibility = markVis = vis;
      if (op !== markOpacity) markEl.style.opacity = markOpacity = op;
      if (p === 0) return;

      // Hairline gaps between the squares. On scroll each square's gaps open only just before it comes loose
      // (SEAM_FRONT), so the inside stays joined and solid until the crumble reaches it. The build is the same in
      // reverse, only tighter: a square's gaps shut the moment it lands
      const gapMax = Math.max(1, cellPx * 0.08 * dpr);
      const off = cellPx * 2;
      // In the build, squares still flying in pass behind the ones already home, so the built part stays one solid shape
      for (const pass of introActive ? [0, 1] : [-1])
        for (const cell of cells) {
          if (pass >= 0 && p - cell.d > -LEAD !== (pass === 0)) continue;
          const keep = cell.throw !== undefined && kept.has(cell.throw);
          if (throwing && cell.throw !== undefined && !keep && p > cell.d) continue; // on the pin canvas
          // A kept bullet's square is already in its bullet: its copy in the mark only shows near home
          const alpha = keep ? 1 - smoothstep(clamp((p - cell.d) / KEPT_FADE)) : 1;
          if (alpha <= 0) continue;
          const [x, y, rot] = place(cell, p);
          if (y - off > H || x + off < 0 || x - off > W) continue;
          ctx.globalAlpha = alpha;
          const seam = introActive
            ? p > cell.d
              ? 1
              : 0 // the build: gaps only while flying, shut the moment a square lands
            : smoothstep(clamp((p - cell.d + SEAM_FRONT) / SEAM_FRONT));
          // In the build a landed square that's still settling overlaps its neighbours by a device pixel, so the
          // soft edges of tilted squares never show as a faint grid
          const settling = introActive && seam === 0 && (rot !== 0 || x !== cell.x0 || y !== cell.y0);
          const gap = settling ? -1 : seam * gapMax,
            g2 = gap / 2;
          const iw = cell.sw - gap,
            ih = cell.sh - gap;
          heroDirty = true;
          if (rot === 0 && x === cell.x0 && y === cell.y0) {
            // Resting squares are copied straight across at their home pixels
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const dx = Math.round(x * dpr - cell.sw / 2),
              dy = Math.round(y * dpr - cell.sh / 2);
            ctx.drawImage(offscreen, cell.sx + g2, cell.sy + g2, iw, ih, dx + g2, dy + g2, iw, ih);
          } else {
            // Moving squares keep sub-pixel positions so motion stays fluid
            const cos = Math.cos(rot),
              sin = Math.sin(rot);
            ctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr);
            ctx.drawImage(offscreen, cell.sx + g2, cell.sy + g2, iw, ih, -iw / 2, -ih / 2, iw, ih);
          }
        }
      ctx.globalAlpha = 1;
    }

    // Thrown squares in flight, plus each bullet's state: empty or filled and its landing bump
    function renderThrown(p, throwing) {
      // The pin canvas is only cleared when a square was in flight last frame
      if (pinDirty) {
        pctx.setTransform(1, 0, 0, 1, 0, 0);
        pctx.clearRect(0, 0, pinCanvas.width, pinCanvas.height);
        pinDirty = false;
      }
      for (const cell of thrown) {
        const i = cell.throw,
          b = bullets[i];
        const keep = kept.has(i);
        const t = keep ? THROW + BUMP : throwing ? p - cell.d : -1; // kept: landed, bump done, nothing in flight
        const landed = t >= THROW;
        const vis = landed ? "" : "hidden";
        if (vis !== bulletVis[i]) b.style.visibility = bulletVis[i] = vis;
        const bump = landed ? Math.sin(Math.PI * clamp((t - THROW) / BUMP)) : 0;
        const tf =
          bump > 0.001
            ? `translateY(${(bump * 2).toFixed(2)}px) scale(${(1 + bump * 0.3).toFixed(3)}, ${(1 - bump * 0.3).toFixed(3)})`
            : "";
        if (tf !== bulletTf[i]) b.style.transform = bulletTf[i] = tf;
        if (t <= 0 || landed) continue;
        pinDirty = true;
        const [x, y, rot, s] = throwPlace(cell, p);
        const cos = Math.cos(rot) * dpr,
          sin = Math.sin(rot) * dpr;
        pctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr);
        pctx.drawImage(offscreen, cell.sx, cell.sy, cell.sw, cell.sh, -s / 2, -s / 2, s, s);
      }
    }

    function scrollProgress(y = scrollY) {
      // 0 when the hero first pins under the navbar. The pinned stretch is RELEASE_AT of the erode; the hero then
      // lets go and the page scrolls on at the same rate. Worked out from the cached measurements
      return scrollDist > 0 ? clamp((pinTop - (trackY - y)) / (scrollDist / RELEASE_AT)) : 0;
    }

    /* ---------- Tagline square: one square pops off the mark onto it ---------- */

    // Highest point of the throw arc (pin space), for a drop of dy and a hop of size arc
    function arcPeak(y1, dy, arc) {
      const T = clamp((4 * arc) / (2 * dy + 8 * arc));
      return y1 + dy * T * T - arc * 4 * T * (1 - T);
    }

    function preparePop() {
      popPath = null;
      if (!popCell || !popTarget) return;
      const x1 = popCell.x0,
        y1 = popCell.y0 + heroY;
      const dx = popTarget.x - x1,
        dy = popTarget.y - y1;
      // The bullets' hop, kept low enough that the square never rises out of the hero under the navbar
      let arc = cellPx * 4 + Math.abs(dx) * 0.15;
      for (let i = 0; i < 40 && arcPeak(y1, dy, arc) < heroY + cellPx; i++) arc *= 0.9;
      popPath = { x1, y1, dx, dy, arc, base: popEl.offsetWidth || popTarget.s };
    }

    // Same shape as the bullet throw: eased across, gravity down, a half turn so it lands square, shrinking to the tagline square
    function popPlace(T) {
      const { x1, y1, dx, dy, arc } = popPath;
      const e = smoothstep(T);
      return [
        x1 + dx * e,
        y1 + dy * T * T - arc * 4 * T * (1 - T),
        -Math.PI * e,
        cellPx + (popTarget.s - cellPx) * e,
      ];
    }

    function startPop(now) {
      popState = "fly";
      popStart = now;
      popAt = 0;
      popEl.style.visibility = "visible";
    }

    // Moves the flying square; returns true while there's still something to animate
    function updatePop(now) {
      const k = (now - popStart) / POP_MS;
      if (k < 1) {
        const [x, y, rot, s] = popPlace(k),
          b = popPath.base;
        popEl.style.transform = `translate(${(x - b / 2).toFixed(2)}px, ${(y - b / 2).toFixed(2)}px) rotate(${rot.toFixed(4)}rad) scale(${(s / b).toFixed(4)})`;
        return true;
      }
      // Landed: the tagline square takes over and gives the bullets' landing bump
      popEl.style.visibility = "hidden";
      tagPixel.classList.remove("hero-js-empty");
      const t = (now - popStart - POP_MS) / POP_BUMP_MS;
      if (t >= 1) {
        settlePop();
        return false;
      }
      const bump = Math.sin(Math.PI * clamp(t));
      tagPixel.style.transform = `translateY(${(bump * 2).toFixed(2)}px) scale(${(1 + bump * 0.3).toFixed(3)}, ${(1 - bump * 0.3).toFixed(3)})`;
      return true;
    }

    // In place for good: the tagline square shows, nothing in flight
    function settlePop() {
      popState = "off";
      popAt = 0;
      popEl.style.visibility = "hidden";
      tagPixel.classList.remove("hero-js-empty");
      tagPixel.style.transform = "";
    }

    /* ---------- H1 reveal ---------- */

    // The C's outer edge as a polyline in hero px (follows the mark's current scale and position)
    function edgePoints() {
      const pts = [];
      for (const [a, b, c, d] of C_EDGE) {
        for (let i = 0; i <= 32; i++) {
          const t = i / 32,
            u = 1 - t;
          const k0 = u * u * u,
            k1 = 3 * u * u * t,
            k2 = 3 * u * t * t,
            k3 = t * t * t;
          pts.push([
            originX + (k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0]) * scaleX,
            originY + (k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]) * scaleY,
          ]);
        }
      }
      return pts;
    }
    // x of the edge at height y; above and below the mark the edge carries straight on
    function edgeX(pts, y) {
      if (y <= pts[0][1]) return pts[0][0];
      for (let i = 1; i < pts.length; i++) {
        if (y > pts[i][1]) continue;
        const [x0, y0] = pts[i - 1],
          [x1, y1] = pts[i];
        return y1 > y0 ? x0 + ((x1 - x0) * (y - y0)) / (y1 - y0) : Math.max(x0, x1);
      }
      return pts[pts.length - 1][0];
    }

    // Wrap the heading's lines, as the browser breaks them, in spans that can slide
    function splitHeading() {
      heading.textContent = "";
      const words = headingText.split(" ").map((w, i) => {
        const span = document.createElement("span");
        span.textContent = w;
        if (i) heading.append(" ");
        heading.append(span);
        return span;
      });
      const rows = [];
      let top = null;
      for (const w of words) {
        if (w.offsetTop !== top) {
          rows.push([]);
          top = w.offsetTop;
        }
        rows[rows.length - 1].push(w.textContent);
      }
      heading.textContent = "";
      return rows.map((row, i) => {
        const line = document.createElement("span");
        line.className = "hero-js-line";
        line.textContent = row.join(" ");
        line.style.setProperty("--i", i);
        if (i) heading.append(" ");
        heading.append(line);
        return line;
      });
    }

    // Tuck every line inside the mark, just right of the C's edge, and clip the heading to the edge
    function prepHeading() {
      settleHeading();
      const lines = splitHeading();
      const hr = hero.getBoundingClientRect(),
        r = heading.getBoundingClientRect();
      const left = r.left - hr.left,
        top = r.top - hr.top;
      const pts = edgePoints();
      const range = document.createRange();
      let fits = true;
      lines.forEach((line) => {
        const lr = line.getBoundingClientRect();
        let near = Infinity,
          far = -Infinity;
        for (let k = 0; k <= 8; k++) {
          const x = edgeX(pts, lr.top - hr.top + (lr.height * k) / 8);
          near = Math.min(near, x);
          far = Math.max(far, x);
        }
        range.selectNodeContents(line);
        if (range.getBoundingClientRect().right - hr.left > near) fits = false; // the line would sit under the mark at rest
        line.style.setProperty("--from", (far - left + 8).toFixed(1) + "px");
      });
      // Narrow screens put the mark under the copy, so there's no edge to come out of: just show the heading
      if (pts[0][1] > r.bottom - hr.top) {
        heading.innerHTML = headingHTML;
        return;
      }
      const L = 10000;
      const poly = (dx) =>
        "polygon(" +
        [[-L, -L], [pts[0][0] + dx, -L], ...pts.map(([x, y]) => [x + dx, y]), [pts[pts.length - 1][0] + dx, L], [-L, L]]
          .map(([x, y]) => `${(x - left).toFixed(1)}px ${(y - top).toFixed(1)}px`)
          .join(", ") +
        ")";
      heading.style.clipPath = poly(0);
      // A line that runs under the mark at rest is cut at the C's edge until it lands; then the clip slides open
      headingOpenClip = fits ? "" : poly((3 * L) / 10);
      heading.classList.add("hero-js-pre");
      headingState = "pre";
    }

    function revealHeading() {
      if (headingState !== "pre") return;
      headingState = "out";
      heading.classList.replace("hero-js-pre", "hero-js-out");
      const lines = heading.querySelectorAll(".hero-js-line").length;
      headingTimer = setTimeout(() => {
        if (!headingOpenClip) return settleHeading();
        heading.style.transition = `clip-path ${HEADING_OPEN_MS}ms cubic-bezier(.16, 1, .3, 1)`;
        heading.style.clipPath = headingOpenClip;
        headingTimer = setTimeout(settleHeading, HEADING_OPEN_MS + 30);
      }, HEADING_MS + HEADING_STAGGER_MS * (lines - 1));
    }

    // Out for good: plain text again, no clip, nothing left for the scroll to reverse
    function settleHeading() {
      clearTimeout(headingTimer);
      if (headingState === "rest") return;
      heading.classList.remove("hero-js-pre", "hero-js-out");
      heading.style.clipPath = "";
      heading.style.transition = "";
      heading.innerHTML = headingHTML;
      headingState = "rest";
    }

    /* ---------- Frame loop: runs only while something is moving ---------- */
    let raf = 0,
      lastTime = 0;
    function tick(now) {
      raf = 0;
      if (!ready) return;
      // The first frame after a restart takes one nominal frame instead of measuring (a negative step eased backwards)
      const dt = lastTime ? clamp((now - lastTime) / 1000, 0, MAX_DT) : FIRST_DT;
      lastTime = now;

      const target = scrollProgress();
      smoothP += (target - smoothP) * (1 - Math.exp(-dt * SMOOTHING));
      if (Math.abs(target - smoothP) < 0.0005) smoothP = target;

      let introP = 0;
      if (introActive) {
        // The build plays at its own pace whatever the scroll does: no rush to the end, no freeze
        const t = clamp((now - introStart) / INTRO_MS);
        introP = 1 - easeOutCubic(t);
        // The mark looks built: the H1 comes out now and the tagline square pops just after it
        if (!headed && introP <= headingAt) {
          headed = true;
          revealHeading();
          if (popState === "wait") popAt = now + POP_AFTER_MS;
        }
        if (t >= 1) {
          // Fully built: the scroll takes over from wherever the page is now
          introActive = false;
          scrollFrom = smoothP;
        }
      }
      if (popState === "wait" && popAt && now >= popAt) startPop(now);
      const popping = popState === "fly" && updatePop(now);

      // Self-heal: the erode runs backwards on the load build's curve, from where the mark was when it started
      let healP = 0;
      if (healing) {
        const t = healT0 + ((now - healStart) * HEAL_SPEED) / INTRO_MS;
        if (t >= 1) {
          // Whole again: the erode now starts from here, so scrolling up keeps it whole and scrolling down crumbles it
          healing = false;
          scrollFrom = smoothP;
        } else {
          healP = Math.pow(1 - t, 3);
        }
      }
      // Scroll erode, measured from where the page was when the build finished (or a heal ended) and spread over the
      // rest of the track, so it starts at 0 (no jump). Scrolling back up gives the head start back
      scrollFrom = Math.min(scrollFrom, smoothP);
      const erodeP = introActive || scrollFrom >= 1 ? 0 : clamp((smoothP - scrollFrom) / (1 - scrollFrom));
      const p = introActive ? introP : healing ? healP : erodeP;
      // Landing squares settle with less sink and tilt, so the build closes up cleanly
      loosen = introActive ? BUILD_LOOSEN : 1;
      // During the intro the throw plays backwards on the build-in's timing; on scroll it plays forwards on the
      // landing schedule. Both are at rest at 0, so no jump. A kept bullet's square crumbles with the rest
      for (const cell of cells) if (cell.throw === undefined) cell.d = introActive ? cell.dBuild : cell.dCrumble;
      for (const cell of thrown)
        cell.d = kept.has(cell.throw)
          ? Math.min(cell.dCrumble, cell.dLand)
          : introActive
            ? cell.dIntro
            : cell.dLand;
      if (p !== lastP) {
        lastP = p;
        // The bullets stay empty through the build; they only fill once scrolling throws squares down
        render(p, !introActive);
      }
      if (introActive || healing || popping || (popState === "wait" && popAt) || smoothP !== target)
        raf = requestAnimationFrame(tick);
    }

    // Share of the mark on screen between the navbar and the bottom of the window, from the cached measurements
    function markShown() {
      const top = pinViewTop(scrollY) + heroY + originY,
        h = FRAME_H * scaleY;
      return h > 0 ? clamp((Math.min(innerHeight, top + h) - Math.max(lineTop, top)) / h) : 0;
    }

    // HEAL_DELAY_MS after the last scroll: if the mark is broken and still mostly on screen, it rebuilds itself.
    // The page never moves; only the mark animates
    function tryHeal() {
      healTimer = 0;
      if (!ready || introActive || healing || lastP <= HEAL_MIN_P || lastP >= 1 || markShown() < HEAL_MIN_SHOWN) return;
      // Landed bullet squares fly back up into the mark with the rest, so none get left behind
      kept.clear();
      smoothP = scrollProgress(); // the scroll easing is all but settled by now; finish it so the hand-off maths is exact
      healY = scrollY;
      healT0 = 1 - Math.cbrt(lastP); // the point on the build curve, 1 - easeOutCubic(t), where the mark is now
      healStart = performance.now();
      healing = true;
      request();
    }

    // Scrolling during a heal stops it where it is: the erode picks up from the mark's current state at this scroll
    // position (solving (smoothP - scrollFrom) / (1 - scrollFrom) = lastP), so there's no jump either way
    function stopHeal() {
      healing = false;
      scrollFrom = lastP < 1 ? clamp((smoothP - lastP) / (1 - lastP)) : smoothP;
    }
    const request = () => {
      if (raf || !ready) return;
      lastTime = 0; // restart: tick takes FIRST_DT for its first step
      raf = requestAnimationFrame(tick);
    };

    // The mark has no box at this width (hidden in Webflow), or the pin can't pin: put everything back to the plain
    // static page
    function park() {
      ready = introActive = healing = false;
      lastP = -1;
      settleHeading();
      settlePop();
      markEl.style.visibility = "";
      markEl.style.opacity = "";
      markVis = markOpacity = null;
      bullets.forEach((b, i) => {
        b.style.visibility = "";
        b.style.transform = "";
        bulletVis[i] = bulletTf[i] = undefined;
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.clearRect(0, 0, pinCanvas.width, pinCanvas.height);
      heroDirty = pinDirty = false;
    }

    // Measure again and rebuild the squares. On its own (an element changed size, late fonts, a new pixel density) it
    // lets whatever is playing carry on: an H1 still waiting inside the mark is split again for its new line breaks
    function refit() {
      layout();
      if (!active) return park();
      drawMark();
      buildCells();
      scheduleLanding();
      preparePop();
      if (!popPath && popState !== "off") settlePop(); // the tagline square lost its box: just show it
      if (headingState === "pre") prepHeading();
      ready = true;
      lastP = -1;
      request();
    }

    // Window resize: anything mid-play is put in place first
    function rebuild() {
      settleHeading(); // a resize mid-reveal just puts the heading in place
      settlePop(); // ...and the tagline square
      refit();
    }

    function playIntro() {
      if (!ready) return;
      prepHeading();
      // The tagline square starts empty until a square pops off the mark onto it
      settlePop();
      if (popPath) {
        popState = "wait";
        tagPixel.classList.add("hero-js-empty");
      }
      headed = false;
      introStart = performance.now();
      introActive = true;
      // Guard: whatever goes wrong with the frame loop, the H1 doesn't stay hidden in the mark
      clearTimeout(headingGuard);
      headingGuard = setTimeout(() => {
        if (headingState === "pre") settleHeading();
      }, INTRO_MS + HEADING_MS + 1000);
      markEl.style.visibility = markVis = "hidden";
      // The bullets stay hidden until scrolling throws their squares in
      bullets.forEach((b, i) => {
        b.style.visibility = bulletVis[i] = "hidden";
      });
      lastP = -1;
      request();
    }

    // One debounce for every re-measure. A window resize asks for a full rebuild (settle first); the observers below
    // only ask for a refit. If both come in, the rebuild wins
    let resizeTimer = 0,
      resizeSettle = false;
    function scheduleRebuild(settle) {
      resizeSettle = resizeSettle || settle;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const s = resizeSettle;
        resizeSettle = false;
        if (s) rebuild();
        else refit();
      }, 120);
    }
    addEventListener("resize", () => scheduleRebuild(true));
    // One scroll handler: a frame for the erode if the loop isn't already running, and the self-heal: a heal in
    // progress stops if the page really moved, and the stillness timer restarts
    addEventListener(
      "scroll",
      () => {
        if (healing && scrollY !== healY) stopHeal();
        clearTimeout(healTimer);
        healTimer = setTimeout(tryHeal, HEAL_DELAY_MS);
        request();
      },
      { passive: true }
    );
    addEventListener("resize", measureScroll);
    // The pin or the track changing size (late fonts, the vh height settling) moves the scroll stretch: measure again
    new ResizeObserver(() => {
      measureScroll();
      if ((pinSticky && scrollDist > 0) !== scrollable) scheduleRebuild(false); // it can't pin any more, or can again
      request();
    }).observe(pin);
    // The hero or the mark box changing size moves the mark: refit. Only real changes count (the observer also
    // reports each element once when it starts watching)
    const seenSize = new Map();
    const boxObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const size = e.contentRect.width + "x" + e.contentRect.height;
        if (seenSize.has(e.target) && seenSize.get(e.target) !== size) changed = true;
        seenSize.set(e.target, size);
      }
      if (changed) scheduleRebuild(false);
    });
    boxObserver.observe(hero);
    boxObserver.observe(markSvg);
    // Browser zoom or a move to a screen with another pixel density: the canvases are rebuilt at the new density
    (function watchDpr() {
      const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      if (!mq.addEventListener) return;
      mq.addEventListener(
        "change",
        () => {
          watchDpr();
          scheduleRebuild(false);
        },
        { once: true }
      );
    })();

    // The prototype's navbar hairline test: true once content really slides under the bar (the pin has let go).
    // navbar-scroll-line.html can call this instead of scrollY > 0; nothing calls it yet.
    window.heroCrumble = { navLineOn: () => pinViewTop(scrollY) < lineTop - 1 };

    layout(); // measure right away; the canvas copy is built once the fonts have settled the layout
    // Start now: wait for the fonts only a moment. The mark doesn't depend on them; the H1 and the mark's position
    // do, so if they land late (before the H1 is out) the layout and the H1 split are redone
    let started = false;
    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    fontsReady
      .then(() => {
        if (!started || headingState !== "pre") return;
        refit();
      })
      .catch((err) => {
        park();
        if (window.console) console.warn("Hero crumble stopped after the fonts loaded:", err);
      });
    Promise.race([fontsReady, new Promise((r) => setTimeout(r, 100))])
      .then(() => {
        measureScroll();
        smoothP = scrollProgress(); // a reload part-way down starts where the page is
        rebuild();
        if (root.classList.contains("js-intro") && !root.hasAttribute("data-hero-static")) playIntro();
        else {
          // No intro: the head block's failsafe already showed the page (this script came late), or the head block
          // hid nothing (phone width, part 1 not placed). The mark stays whole, the bullets the visitor has seen
          // stay filled, and the scroll crumble starts from where the page is now
          scrollFrom = smoothP;
          bullets.forEach((_, i) => kept.add(i));
          lastP = -1;
          request();
        }
        started = true;
        release();
      })
      .catch((err) => {
        release();
        park();
        if (window.console) console.warn("Hero crumble stopped:", err);
      });
  }

  function start() {
    try { init(); } catch (err) {
      release();
      if (window.console) console.warn("Hero crumble did not start:", err);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
