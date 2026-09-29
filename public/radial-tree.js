function polar(angle, radius) {
  return {
    x: Math.cos(angle - Math.PI / 2) * radius,
    y: Math.sin(angle - Math.PI / 2) * radius,
  };
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function fmt(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function flatten(root) {
  const nodes = [];
  const byId = new Map();

  const walk = (node, depth = 0, parent = null) => {
    const entry = {
      node,
      depth,
      parent,
      children: [],
      startAngle: 0,
      endAngle: 0,
      angle: 0,
      weight: 1,
    };
    nodes.push(entry);
    byId.set(String(node.id), entry);

    for (const child of node.children || []) {
      const childEntry = walk(child, depth + 1, entry);
      entry.children.push(childEntry);
    }
    return entry;
  };

  return { root: walk(root), nodes, byId };
}

function biologicalWeight(entry) {
  const species = Number(entry.node.descendantSpeciesCount || 0);
  if (species > 0) return Math.max(1, species);

  if (!entry.children.length) {
    return Math.max(1, Math.min(32, Number(entry.node.childCount || 1)));
  }

  return Math.max(1, entry.children.reduce((sum, child) => sum + biologicalWeight(child), 0));
}

function calculateWeights(entry) {
  entry.weight = biologicalWeight(entry);
  for (const child of entry.children) calculateWeights(child);

  if (entry.children.length && !Number(entry.node.descendantSpeciesCount || 0)) {
    entry.weight = Math.max(1, entry.children.reduce((sum, child) => sum + child.weight, 0));
  }
  return entry.weight;
}

function assignAngles(entry, start, end) {
  entry.startAngle = start;
  entry.endAngle = end;
  entry.angle = (start + end) / 2;

  if (!entry.children.length) return;

  const span = end - start;
  const minGap = span > Math.PI ? 0.004 : 0.0015;
  const gap = Math.min(0.018, Math.max(minGap, span / Math.max(120, entry.children.length * 7)));
  const usable = Math.max(0.001, span - gap * Math.max(0, entry.children.length - 1));
  const totalWeight = Math.max(1, entry.children.reduce((sum, child) => sum + child.weight, 0));

  let cursor = start;
  for (const child of entry.children) {
    const childSpan = usable * (child.weight / totalWeight);
    assignAngles(child, cursor, cursor + childSpan);
    cursor += childSpan + gap;
  }
}

function branchPath(parent, child, ring) {
  const a = polar(parent.angle, parent.depth * ring);
  const b = polar(child.angle, child.depth * ring);
  const middleRadius = (parent.depth + child.depth) * ring / 2;
  const c1 = polar(parent.angle, middleRadius);
  const c2 = polar(child.angle, middleRadius);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)}, ${c2.x.toFixed(2)} ${c2.y.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function annularSectorPath(entry, ring, bandWidth) {
  if (!entry.depth) return "";

  const inner = Math.max(4, entry.depth * ring - bandWidth * 0.5);
  const outer = entry.depth * ring + bandWidth * 0.5;
  const span = Math.max(0.001, entry.endAngle - entry.startAngle);
  const pad = Math.min(0.006, span * 0.08);
  const startAngle = entry.startAngle + pad;
  const endAngle = entry.endAngle - pad;
  if (endAngle <= startAngle) return "";

  const a = polar(startAngle, inner);
  const b = polar(endAngle, inner);
  const c = polar(endAngle, outer);
  const d = polar(startAngle, outer);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${a.x.toFixed(2)} ${a.y.toFixed(2)}`,
    `A ${inner.toFixed(2)} ${inner.toFixed(2)} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
    `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`,
    `A ${outer.toFixed(2)} ${outer.toFixed(2)} 0 ${large} 0 ${d.x.toFixed(2)} ${d.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function labelPriority(entry) {
  const species = Number(entry.node.descendantSpeciesCount || 0);
  if (entry.depth <= 1 || species >= 10_000) return "hero";
  if (entry.depth <= 2 || species >= 1_000) return "high";
  if (entry.depth <= 3 || species >= 100) return "medium";
  return "low";
}

function rankClass(rank = "") {
  return String(rank).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unranked";
}

function isExplorable(node) {
  return Number(node.childCount || 0) > 0 || Number(node.descendantSpeciesCount || 0) > 1;
}

export class RadialTreeMap {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.scale = 0.92;
    this.x = 0;
    this.y = 0;
    this.drag = null;
    this.tooltip = null;
    this.svg = null;
    this.group = null;
    this.model = null;
    this.resizeObserver = null;
  }

  render(payload) {
    this.payload = payload;
    if (!payload?.root) {
      this.container.innerHTML = '<div class="radial-empty">No taxonomy data available.</div>';
      return;
    }

    const model = flatten(payload.root);
    this.model = model;
    calculateWeights(model.root);
    assignAngles(model.root, 0, Math.PI * 2);

    const maxDepth = Math.max(1, ...model.nodes.map((entry) => entry.depth));
    const ring = Math.max(105, Math.min(178, 660 / Math.max(1, maxDepth)));
    const bandWidth = Math.max(22, Math.min(42, ring * 0.28));
    const extent = ring * (maxDepth + 0.75);
    const view = Math.max(900, extent * 2 + 360);

    const visibleSpecies = Number(payload.root.descendantSpeciesCount || 0);
    const hiddenBranches = Number(payload.root.truncatedChildren || payload.root.truncated || 0);
    const ownedCount = model.nodes.filter((entry) => this.options.isOwned?.(entry.node)).length;
    const explorableCount = model.nodes.filter((entry) => isExplorable(entry.node)).length;

    const rings = Array.from({ length: maxDepth }, (_, index) => {
      const radius = (index + 1) * ring;
      return `<circle class="atlas-ring depth-${index + 1}" cx="0" cy="0" r="${radius}"></circle>`;
    }).join("");

    const sectors = model.nodes
      .filter((entry) => entry.depth > 0)
      .map((entry) => {
        const path = annularSectorPath(entry, ring, bandWidth);
        const owned = Boolean(this.options.isOwned?.(entry.node));
        const priority = labelPriority(entry);
        return `<path
          class="atlas-sector depth-${entry.depth} priority-${priority} rank-${rankClass(entry.node.rank)} ${owned ? "owned" : ""}"
          data-atlas-sector="${escapeHtml(entry.node.id)}"
          d="${path}"
        ></path>`;
      }).join("");

    const edges = model.nodes
      .filter((entry) => entry.parent)
      .map((entry) => {
        const owned = Boolean(this.options.isOwned?.(entry.node));
        return `<path
          class="atlas-edge depth-${entry.depth} ${owned ? "owned" : ""}"
          data-atlas-edge="${escapeHtml(entry.node.id)}"
          d="${branchPath(entry.parent, entry, ring)}"
        ></path>`;
      }).join("");

    const labels = model.nodes.map((entry) => {
      const point = polar(entry.angle, entry.depth * ring);
      const species = Number(entry.node.descendantSpeciesCount || 0);
      const direct = Number(entry.node.childCount || 0);
      const owned = Boolean(this.options.isOwned?.(entry.node));
      const priority = labelPriority(entry);
      const explorable = isExplorable(entry.node);
      const label = entry.node.commonName || entry.node.canonicalName || entry.node.scientificName;
      const rank = entry.node.rank || entry.node.kind || "";
      const rightSide = point.x >= 0;
      const nodeRadius = priority === "hero" ? 7 : priority === "high" ? 5.5 : 4;
      const truncated = Number(entry.node.truncatedChildren || entry.node.truncated || 0);

      return `
        <g class="atlas-node priority-${priority} ${owned ? "owned" : ""} ${explorable ? "explorable" : "leaf"}"
           data-radial-id="${escapeHtml(entry.node.id)}"
           transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})">
          <circle class="atlas-node-hit" r="17"></circle>
          <circle class="atlas-node-pulse" r="${nodeRadius + 6}"></circle>
          <circle class="atlas-node-dot" r="${nodeRadius}"></circle>
          <text class="atlas-node-label"
                x="${rightSide ? 14 : -14}"
                y="-2"
                text-anchor="${rightSide ? "start" : "end"}">${escapeHtml(label)}</text>
          <text class="atlas-node-meta"
                x="${rightSide ? 14 : -14}"
                y="11"
                text-anchor="${rightSide ? "start" : "end"}">${escapeHtml(rank)}${species ? ` · ${fmt(species)} spp` : direct ? ` · ${fmt(direct)} branches` : ""}${truncated ? ` · +${fmt(truncated)}` : ""}</text>
        </g>`;
    }).join("");

    const rootName = payload.root.commonName || payload.root.scientificName || "Tree of Life";
    const rootScientific = payload.root.scientificName || rootName;
    const rootOwned = Boolean(this.options.isOwned?.(payload.root));

    this.container.innerHTML = `
      <div class="atlas-toolbar">
        <div class="atlas-focus">
          <span>FOCUS</span>
          <b>${escapeHtml(rootName)}</b>
          <small>${escapeHtml(payload.root.rank || payload.root.kind || "")}${visibleSpecies ? ` · ${fmt(visibleSpecies)} species` : ""}</small>
        </div>

        <div class="atlas-live-stats">
          <span><i></i><b>${fmt(model.nodes.length)}</b> visible</span>
          <span><i></i><b>${fmt(explorableCount)}</b> branches</span>
          <span class="owned"><i></i><b>${fmt(ownedCount)}</b> owned here</span>
        </div>

        <div class="atlas-actions">
          <button data-radial-action="up" title="Parent branch">↑</button>
          <button data-radial-action="home" title="Back to LUCA">◎</button>
          <button data-radial-action="fit" title="Fit map">⌾</button>
          ${hiddenBranches ? `<button class="atlas-more" data-radial-action="more" title="Load more direct branches">+${fmt(hiddenBranches)}</button>` : ""}
          <button data-radial-action="out" title="Zoom out">−</button>
          <button data-radial-action="in" title="Zoom in">+</button>
          <button data-radial-action="fullscreen" title="Fullscreen">⛶</button>
        </div>
      </div>

      <div class="atlas-viewport" tabindex="0" aria-label="Interactive radial Tree of Life">
        <svg class="radial-map-svg" viewBox="${-view / 2} ${-view / 2} ${view} ${view}" aria-label="Phylogenetic atlas">
          <defs>
            <radialGradient id="atlasAura">
              <stop offset="0%" stop-color="#6ef0a7" stop-opacity=".16"></stop>
              <stop offset="58%" stop-color="#6ef0a7" stop-opacity=".035"></stop>
              <stop offset="100%" stop-color="#6ef0a7" stop-opacity="0"></stop>
            </radialGradient>
            <filter id="ownedGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="4" result="blur"></feGaussianBlur>
              <feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>
            </filter>
          </defs>

          <circle class="atlas-aura" cx="0" cy="0" r="${Math.max(ring * 1.2, 170)}"></circle>

          <g class="radial-viewport-group">
            <g class="atlas-grid">${rings}</g>
            <g class="atlas-sectors">${sectors}</g>
            <g class="atlas-edges">${edges}</g>
            <g class="atlas-nodes">${labels}</g>

            <g class="atlas-center ${rootOwned ? "owned" : ""}" data-radial-id="${escapeHtml(payload.root.id)}">
              <circle class="atlas-center-orbit orbit-a" r="48"></circle>
              <circle class="atlas-center-orbit orbit-b" r="34"></circle>
              <circle class="atlas-center-core" r="24"></circle>
              <text class="atlas-center-title" y="-2">${escapeHtml(rootName)}</text>
              <text class="atlas-center-rank" y="12">${escapeHtml(payload.root.rank || payload.root.kind || "")}</text>
            </g>
          </g>
        </svg>

        <aside class="atlas-inspector">
          <span class="atlas-inspector-kicker">PHYLOGENETIC POSITION</span>
          <b id="atlasInspectorName">${escapeHtml(rootName)}</b>
          <em id="atlasInspectorScientific">${escapeHtml(rootScientific)}</em>
          <div id="atlasInspectorMeta" class="atlas-inspector-meta">
            <span>${escapeHtml(payload.root.rank || payload.root.kind || "root")}</span>
            ${visibleSpecies ? `<span>${fmt(visibleSpecies)} species</span>` : ""}
          </div>
          <small>Hover a branch to inspect it. Click to dive deeper.</small>
        </aside>

        <div class="atlas-legend">
          <span><i class="branch"></i>clade</span>
          <span><i class="owned"></i>owned</span>
          <span><i class="leaf"></i>species / leaf</span>
        </div>

        <div class="atlas-zoom-readout">90%</div>
        <div class="radial-tooltip"></div>
      </div>
    `;

    this.svg = this.container.querySelector(".radial-map-svg");
    this.group = this.container.querySelector(".radial-viewport-group");
    this.tooltip = this.container.querySelector(".radial-tooltip");
    this.zoomReadout = this.container.querySelector(".atlas-zoom-readout");

    this.wire(model.nodes, model.byId);
    this.reset({ animate: false });
    requestAnimationFrame(() => this.container.classList.add("atlas-ready"));
  }

  setInspector(node) {
    if (!node) return;

    const name = this.container.querySelector("#atlasInspectorName");
    const scientific = this.container.querySelector("#atlasInspectorScientific");
    const meta = this.container.querySelector("#atlasInspectorMeta");
    if (!name || !scientific || !meta) return;

    const speciesCount = Number(node.descendantSpeciesCount || 0);
    const directChildren = Number(node.childCount || 0);
    const owned = Boolean(this.options.isOwned?.(node));

    name.textContent = node.commonName || node.scientificName || "Unknown taxon";
    scientific.textContent = node.scientificName || "";
    meta.innerHTML = [
      node.rank || node.kind || "unranked",
      speciesCount ? `${fmt(speciesCount)} species` : null,
      directChildren ? `${fmt(directChildren)} direct branches` : null,
      owned ? "owned" : null,
    ].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join("");
  }

  highlightLineage(entry) {
    if (!this.container || !entry) return;
    const lineage = new Set();
    let cursor = entry;
    while (cursor) {
      lineage.add(String(cursor.node.id));
      cursor = cursor.parent;
    }

    this.container.classList.add("has-highlight");
    this.container.querySelectorAll("[data-atlas-sector],[data-atlas-edge],[data-radial-id]").forEach((element) => {
      const id = element.dataset.atlasSector || element.dataset.atlasEdge || element.dataset.radialId;
      element.classList.toggle("in-lineage", lineage.has(String(id)));
      element.classList.toggle("is-hovered", String(id) === String(entry.node.id));
    });
  }

  clearHighlight() {
    this.container.classList.remove("has-highlight");
    this.container.querySelectorAll(".in-lineage,.is-hovered").forEach((element) => {
      element.classList.remove("in-lineage", "is-hovered");
    });
    this.setInspector(this.payload?.root);
  }

  wire(nodes, byId) {
    const lookup = byId || new Map(nodes.map((entry) => [String(entry.node.id), entry]));
    const viewport = this.container.querySelector(".atlas-viewport");

    const entryFromTarget = (target) => {
      const element = target?.closest?.("[data-radial-id],[data-atlas-sector]");
      if (!element || !this.container.contains(element)) return null;
      const id = String(element.dataset.radialId || element.dataset.atlasSector || "");
      const entry = lookup.get(id);
      return entry ? { entry, element } : null;
    };

    this.container.addEventListener("pointerover", (event) => {
      const hit = entryFromTarget(event.target);
      if (!hit) return;
      const previous = entryFromTarget(event.relatedTarget);
      if (previous?.entry === hit.entry) return;

      this.setInspector(hit.entry.node);
      this.highlightLineage(hit.entry);

      if (!this.tooltip) return;
      const speciesCount = Number(hit.entry.node.descendantSpeciesCount || 0);
      const directChildren = Number(hit.entry.node.childCount || 0);
      this.tooltip.innerHTML = `
        <b>${escapeHtml(hit.entry.node.commonName || hit.entry.node.scientificName)}</b>
        <em>${escapeHtml(hit.entry.node.scientificName || "")}</em>
        <span>${escapeHtml(hit.entry.node.rank || hit.entry.node.kind || "")}
          ${speciesCount ? ` · ${fmt(speciesCount)} species` : ""}
          ${directChildren ? ` · ${fmt(directChildren)} branches` : ""}
        </span>`;
      this.tooltip.classList.add("visible");
      this.moveTooltip(event);
    });

    this.container.addEventListener("pointermove", (event) => {
      if (this.tooltip?.classList.contains("visible")) this.moveTooltip(event);
    });

    this.container.addEventListener("pointerout", (event) => {
      const from = entryFromTarget(event.target);
      if (!from) return;
      const to = entryFromTarget(event.relatedTarget);
      if (to?.entry === from.entry) return;
      this.tooltip?.classList.remove("visible");
      this.clearHighlight();
    });

    this.container.addEventListener("click", async (event) => {
      const actionButton = event.target.closest?.("[data-radial-action]");
      if (actionButton) {
        event.stopPropagation();
        const action = actionButton.dataset.radialAction;
        if (action === "in") this.zoom(1.22);
        if (action === "out") this.zoom(1 / 1.22);
        if (action === "fit") this.reset();
        if (action === "home") this.options.onHome?.();
        if (action === "up") this.options.onUp?.(this.payload);
        if (action === "more") this.options.onMore?.(this.payload.root);
        if (action === "fullscreen") {
          if (document.fullscreenElement) await document.exitFullscreen?.();
          else await this.container.requestFullscreen?.();
        }
        return;
      }

      const hit = entryFromTarget(event.target);
      if (!hit) return;
      event.stopPropagation();

      if (isExplorable(hit.entry.node) && String(hit.entry.node.id) !== String(this.payload.root.id)) {
        this.container.classList.add("atlas-diving");
        this.options.onFocus?.(hit.entry.node);
      } else {
        this.options.onSelect?.(hit.entry.node);
      }
    });

    viewport?.addEventListener("wheel", (event) => {
      event.preventDefault();

      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const previousScale = this.scale;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextScale = Math.max(0.34, Math.min(5.2, previousScale * factor));

      const ratio = nextScale / previousScale;
      this.x = px - (px - this.x) * ratio;
      this.y = py - (py - this.y) * ratio;
      this.scale = nextScale;
      this.applyTransform();
    }, { passive: false });

    viewport?.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("[data-radial-id],[data-atlas-sector],button")) return;
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        startX: this.x,
        startY: this.y,
      };
      viewport.setPointerCapture?.(event.pointerId);
      viewport.classList.add("dragging");
    });

    viewport?.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      this.x = this.drag.startX + (event.clientX - this.drag.x);
      this.y = this.drag.startY + (event.clientY - this.drag.y);
      this.applyTransform();
    });

    const stopDrag = () => {
      this.drag = null;
      viewport?.classList.remove("dragging");
    };

    viewport?.addEventListener("pointerup", stopDrag);
    viewport?.addEventListener("pointercancel", stopDrag);

    viewport?.addEventListener("keydown", (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        this.zoom(1.18);
      }
      if (event.key === "-") {
        event.preventDefault();
        this.zoom(1 / 1.18);
      }
      if (event.key === "0") {
        event.preventDefault();
        this.reset();
      }
      if (event.key === "Home") {
        event.preventDefault();
        this.options.onHome?.();
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        this.options.onUp?.(this.payload);
      }

      const step = 42;
      if (event.key === "ArrowLeft") this.x += step;
      else if (event.key === "ArrowRight") this.x -= step;
      else if (event.key === "ArrowUp") this.y += step;
      else if (event.key === "ArrowDown") this.y -= step;
      else return;

      event.preventDefault();
      this.applyTransform();
    });
  }

  revealTarget(id) {
    const key=String(id||"");
    if(!key)return;
    const selector='[data-radial-id="'+CSS.escape(key)+'"]';
    const element=this.container.querySelector(selector);
    const entry=this.model?.byId?.get(key);
    if(!element||!entry)return;

    element.classList.add("atlas-target");
    this.setInspector(entry.node);
    this.highlightLineage(entry);

    const point=polar(entry.angle,entry.depth*Math.max(105,Math.min(178,660/Math.max(1,...this.model.nodes.map(item=>item.depth)))));
    this.scale=Math.max(this.scale,1.25);
    this.x=-point.x*this.scale*.42;
    this.y=-point.y*this.scale*.42;
    this.applyTransform();

    setTimeout(()=>{
      element.classList.remove("atlas-target");
      this.clearHighlight();
    },2600);
  }

  moveTooltip(event) {
    if (!this.tooltip) return;
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left + 16;
    const y = event.clientY - rect.top + 16;
    const maxX = Math.max(10, rect.width - 280);
    const maxY = Math.max(10, rect.height - 130);
    this.tooltip.style.left = `${Math.min(maxX, Math.max(10, x))}px`;
    this.tooltip.style.top = `${Math.min(maxY, Math.max(10, y))}px`;
  }

  zoom(factor) {
    this.scale = Math.max(0.34, Math.min(5.2, this.scale * factor));
    this.applyTransform();
  }

  reset({ animate = true } = {}) {
    this.scale = 0.92;
    this.x = 0;
    this.y = 0;
    if (animate) this.container.classList.add("atlas-fitting");
    this.applyTransform();
    if (animate) setTimeout(() => this.container.classList.remove("atlas-fitting"), 320);
  }

  applyTransform() {
    if (!this.group) return;
    this.group.style.transformOrigin = "center";
    this.group.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;

    const zoom = this.scale < 0.62
      ? "overview"
      : this.scale < 1.05
        ? "atlas"
        : this.scale < 1.8
          ? "detail"
          : "microscope";

    if (this.svg) this.svg.dataset.zoom = zoom;
    if (this.zoomReadout) this.zoomReadout.textContent = `${Math.round(this.scale * 100)}%`;
  }
}
