/* ==========================================================================
   Renderer — a small canvas renderer + loop for building your own 2D physics.

   You write the physics in a separate script. It only talks to this API:

     Renderer.onUpdate((dt) => { ... });   // called at a FIXED timestep
     Renderer.onDraw((r) => { ... });      // called once per frame, draw here

   Example physics.js:

     const ball = { x: 100, y: 100, vx: 120, vy: 0, r: 20 };
     Renderer.onUpdate((dt) => {
       ball.vy += 980 * dt;
       ball.x += ball.vx * dt;
       ball.y += ball.vy * dt;
     });
     Renderer.onDraw((r) => {
       r.circle(ball.x, ball.y, ball.r, { fill: "#6cf" });
     });

   Conventions
     - World units are CSS pixels. Origin is top-left, +x right, +y DOWN.
     - Angles are in radians.
     - Style objects: { fill, stroke, lineWidth, alpha, dash }
   ========================================================================== */

(function () {
  "use strict";

  // ---- Config ------------------------------------------------------------
  const config = {
    background: "#14171c",
    step: 1 / 60,          // fixed physics timestep (seconds)
    maxSubSteps: 5,        // cap to avoid the "spiral of death" after a lag spike
    defaultFill: "#6cf",
    defaultStroke: "#ffffff",
    defaultLineWidth: 1.5,
    showHud: true,
  };

  // ---- State -------------------------------------------------------------
  const canvas = document.getElementById("view");
  const ctx = canvas.getContext("2d");
  const hudFps = document.getElementById("fps");
  const hudStatus = document.getElementById("status");
  const hud = document.getElementById("hud");

  const updateHooks = [];
  const drawHooks = [];
  const resizeHooks = [];
  const pointerHooks = { down: [], up: [], move: [] };
  const keyHooks = { down: [], up: [] };

  const camera = { x: 0, y: 0, zoom: 1 }; // x,y = world point at screen top-left
  const view = { width: 0, height: 0, dpr: 1 }; // width/height in CSS px

  const input = {
    x: 0, y: 0,           // pointer position in WORLD coordinates
    screenX: 0, screenY: 0,
    down: false,
    keys: new Set(),      // currently held keys (event.code, e.g. "Space", "KeyW")
  };

  let running = true;
  let paused = false;
  let timeScale = 1;
  let accumulator = 0;
  let lastTime = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let stepCount = 0;
  let elapsed = 0;

  // ---- Sizing ------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.width = w;
    view.height = h;
    view.dpr = dpr;
    for (const fn of resizeHooks) fn(w, h);
  }
  window.addEventListener("resize", resize);

  // ---- Coordinate helpers ------------------------------------------------
  function screenToWorld(sx, sy) {
    return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
  }
  function worldToScreen(wx, wy) {
    return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
  }

  // ---- Style helper ------------------------------------------------------
  // Applies a style to the context, then fills/strokes the current path.
  // Pass fill: null or stroke: null to skip either one.
  function paint(style) {
    const s = style || {};
    const fill = s.fill === undefined ? config.defaultFill : s.fill;
    const stroke = s.stroke === undefined ? null : s.stroke;
    ctx.globalAlpha = s.alpha === undefined ? 1 : s.alpha;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = (s.lineWidth || config.defaultLineWidth) / camera.zoom;
      ctx.setLineDash(s.dash ? s.dash.map((d) => d / camera.zoom) : []);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Drawing API (what your physics script calls) ----------------------
  const draw = {
    /** Fill the whole screen. Called automatically each frame. */
    clear(color) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = color || config.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    },

    circle(x, y, radius, style) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      paint(style);
    },

    /** Circle with a line from center to edge so you can see rotation. */
    circleWithAngle(x, y, radius, angle, style) {
      draw.circle(x, y, radius, style);
      draw.line(
        x, y,
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius,
        { stroke: (style && style.stroke) || "#000", lineWidth: 2 }
      );
    },

    /** Rectangle centered on (x, y), optionally rotated. */
    rect(x, y, width, height, angle, style) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle || 0);
      ctx.beginPath();
      ctx.rect(-width / 2, -height / 2, width, height);
      paint(style);
      ctx.restore();
    },

    /** Axis-aligned rectangle from its top-left corner. */
    rectTL(x, y, width, height, style) {
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      paint(style);
    },

    /** points: [{x, y}, ...] in world coordinates. */
    polygon(points, style) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      paint(style);
    },

    line(x1, y1, x2, y2, style) {
      const s = Object.assign({ fill: null, stroke: config.defaultStroke }, style);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      paint(s);
    },

    point(x, y, size, style) {
      draw.circle(x, y, (size || 3) / camera.zoom, style);
    },

    /** Handy for debugging velocities, forces, and contact normals. */
    arrow(x1, y1, x2, y2, style) {
      const s = Object.assign({ fill: null, stroke: "#f96", lineWidth: 2 }, style);
      draw.line(x1, y1, x2, y2, s);
      const a = Math.atan2(y2 - y1, x2 - x1);
      const head = 8 / camera.zoom;
      draw.line(x2, y2, x2 - head * Math.cos(a - 0.4), y2 - head * Math.sin(a - 0.4), s);
      draw.line(x2, y2, x2 - head * Math.cos(a + 0.4), y2 - head * Math.sin(a + 0.4), s);
    },

    /** Text in world space; size is in screen pixels. */
    text(str, x, y, style) {
      const s = style || {};
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1 / camera.zoom, 1 / camera.zoom);
      ctx.font = (s.size || 12) + "px " + (s.font || "ui-monospace, Menlo, Consolas, monospace");
      ctx.textAlign = s.align || "left";
      ctx.textBaseline = s.baseline || "alphabetic";
      ctx.fillStyle = s.fill || "#c9d1d9";
      ctx.globalAlpha = s.alpha === undefined ? 1 : s.alpha;
      ctx.fillText(String(str), 0, 0);
      ctx.restore();
    },

    /** Background grid. Useful to judge scale and motion. */
    grid(spacing, style) {
      const s = Object.assign({ stroke: "rgba(255,255,255,0.06)", lineWidth: 1 }, style);
      const gap = spacing || 50;
      const x0 = Math.floor(camera.x / gap) * gap;
      const y0 = Math.floor(camera.y / gap) * gap;
      const x1 = camera.x + view.width / camera.zoom;
      const y1 = camera.y + view.height / camera.zoom;
      for (let x = x0; x <= x1; x += gap) draw.line(x, camera.y, x, y1, s);
      for (let y = y0; y <= y1; y += gap) draw.line(camera.x, y, x1, y, s);
    },
  };

  // ---- Main loop ---------------------------------------------------------
  function stepOnce() {
    for (const fn of updateHooks) fn(config.step);
    stepCount++;
    elapsed += config.step;
  }

  function renderFrame() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    draw.clear();

    // Apply camera: world -> screen
    ctx.setTransform(
      view.dpr * camera.zoom, 0, 0, view.dpr * camera.zoom,
      -camera.x * camera.zoom * view.dpr,
      -camera.y * camera.zoom * view.dpr
    );
    for (const fn of drawHooks) fn(draw);
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);

    const t = now / 1000;
    let dt = t - lastTime;
    lastTime = t;
    if (dt > 0.25) dt = 0.25; // tab was in background

    if (!paused) {
      accumulator += dt * timeScale;
      let n = 0;
      while (accumulator >= config.step && n < config.maxSubSteps) {
        stepOnce();
        accumulator -= config.step;
        n++;
      }
      if (n === config.maxSubSteps) accumulator = 0; // drop the backlog
    }

    renderFrame();

    // HUD
    frameCount++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      hudFps.textContent = Math.round(frameCount / fpsTimer) + " fps";
      frameCount = 0;
      fpsTimer = 0;
    }
  }

  // ---- Input -------------------------------------------------------------
  function updatePointer(e) {
    const rect = canvas.getBoundingClientRect();
    input.screenX = e.clientX - rect.left;
    input.screenY = e.clientY - rect.top;
    const w = screenToWorld(input.screenX, input.screenY);
    input.x = w.x;
    input.y = w.y;
  }
  canvas.addEventListener("pointerdown", (e) => {
    updatePointer(e);
    input.down = true;
    canvas.setPointerCapture(e.pointerId);
    for (const fn of pointerHooks.down) fn(input.x, input.y, e);
  });
  canvas.addEventListener("pointerup", (e) => {
    updatePointer(e);
    input.down = false;
    for (const fn of pointerHooks.up) fn(input.x, input.y, e);
  });
  canvas.addEventListener("pointermove", (e) => {
    updatePointer(e);
    for (const fn of pointerHooks.move) fn(input.x, input.y, e);
  });
  window.addEventListener("keydown", (e) => {
    input.keys.add(e.code);
    for (const fn of keyHooks.down) fn(e.code, e);
  });
  window.addEventListener("keyup", (e) => {
    input.keys.delete(e.code);
    for (const fn of keyHooks.up) fn(e.code, e);
  });

  // ---- Public API --------------------------------------------------------
  function setStatus() {
    hudStatus.textContent = paused ? "paused" : "running";
  }

  window.Renderer = {
    // Hooks: each returns an unsubscribe function.
    onUpdate(fn)       { updateHooks.push(fn); return () => remove(updateHooks, fn); },
    onDraw(fn)         { drawHooks.push(fn); return () => remove(drawHooks, fn); },
    onResize(fn)       { resizeHooks.push(fn); fn(view.width, view.height); return () => remove(resizeHooks, fn); },
    onPointerDown(fn)  { pointerHooks.down.push(fn); return () => remove(pointerHooks.down, fn); },
    onPointerUp(fn)    { pointerHooks.up.push(fn); return () => remove(pointerHooks.up, fn); },
    onPointerMove(fn)  { pointerHooks.move.push(fn); return () => remove(pointerHooks.move, fn); },
    onKeyDown(fn)      { keyHooks.down.push(fn); return () => remove(keyHooks.down, fn); },
    onKeyUp(fn)        { keyHooks.up.push(fn); return () => remove(keyHooks.up, fn); },

    // Loop control
    pause()        { paused = true; setStatus(); },
    resume()       { paused = false; setStatus(); },
    togglePause()  { paused = !paused; setStatus(); },
    /** Advance exactly one fixed step (handy while paused). */
    step()         { stepOnce(); },
    setTimeScale(s) { timeScale = s; },
    setStep(seconds) { config.step = seconds; },
    stop()         { running = false; },
    start()        { if (!running) { running = true; lastTime = performance.now() / 1000; requestAnimationFrame(frame); } },

    // Read-only-ish state
    get width()    { return view.width; },
    get height()   { return view.height; },
    get time()     { return elapsed; },
    get steps()    { return stepCount; },
    get paused()   { return paused; },
    config,        // tweak at runtime: Renderer.config.background = "#000"
    camera,        // { x, y, zoom }
    input,         // { x, y, down, keys }
    draw,          // the drawing API (same object passed to onDraw)
    ctx,           // raw 2D context, if you need to go lower level
    canvas,

    screenToWorld,
    worldToScreen,
    setHudVisible(v) { hud.style.display = v ? "flex" : "none"; },
  };

  function remove(list, fn) {
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  // ---- Built-in debug keys (remove if they get in your way) --------------
  keyHooks.down.push((code) => {
    if (code === "KeyP") window.Renderer.togglePause();
    if (code === "Period" && paused) window.Renderer.step();
  });

  // ---- Boot --------------------------------------------------------------
  if (!config.showHud) window.Renderer.setHudVisible(false);
  resize();
  setStatus();
  lastTime = performance.now() / 1000;
  requestAnimationFrame(frame);
})();
