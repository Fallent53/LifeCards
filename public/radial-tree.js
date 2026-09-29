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

function flatten(root) {
  const nodes = [];
  const walk = (node, depth = 0, parent = null) => {
    const entry = { node, depth, parent, children: [] };
    nodes.push(entry);
    for (const child of node.children || []) {
      const childEntry = walk(child, depth + 1, entry);
      entry.children.push(childEntry);
    }
    return entry;
  };
  return { root: walk(root), nodes };
}

function calculateWeight(entry) {
  if (!entry.children.length) {
    const species = Number(entry.node.descendantSpeciesCount || 0);
    const direct = Number(entry.node.childCount || 0);
    entry.weight = Math.max(1, species || Math.min(24, direct || 1));
    return entry.weight;
  }
  entry.weight = entry.children.reduce((sum, child) => sum + calculateWeight(child), 0);
  return Math.max(1, entry.weight);
}

function assignAngles(entry, start, end) {
  entry.startAngle = start;
  entry.endAngle = end;
  entry.angle = (start + end) / 2;
  if (!entry.children.length) return;

  const gap = Math.min(0.025, (end - start) / Math.max(10, entry.children.length * 3));
  const usable = Math.max(0.01, (end - start) - gap * Math.max(0, entry.children.length - 1));
  let cursor = start;
  for (const child of entry.children) {
    const span = usable * (child.weight / entry.weight);
    assignAngles(child, cursor, cursor + span);
    cursor += span + gap;
  }
}

function branchPath(parent, child, ring) {
  const a = polar(parent.angle, parent.depth * ring);
  const b = polar(child.angle, child.depth * ring);
  const midRadius = (parent.depth + child.depth) * ring / 2;
  const c1 = polar(parent.angle, midRadius);
  const c2 = polar(child.angle, midRadius);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)}, ${c2.x.toFixed(2)} ${c2.y.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}
function cladeArcPath(entry, ring) {
  if (!entry.depth || entry.endAngle - entry.startAngle < 0.012) return "";
  const radius = entry.depth * ring;
  const start = polar(entry.startAngle, radius);
  const end = polar(entry.endAngle, radius);
  const large = entry.endAngle - entry.startAngle > Math.PI ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}


export class RadialTreeMap {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.scale = 0.9;
    this.x = 0;
    this.y = 0;
    this.drag = null;
    this.tooltip = null;
  }

  render(payload) {
    this.payload = payload;
    if (!payload?.root) {
      this.container.innerHTML = '<div class="radial-empty">No taxonomy data available.</div>';
      return;
    }

    const { root, nodes } = flatten(payload.root);
    calculateWeight(root);
    assignAngles(root, 0, Math.PI * 2);

    const maxDepth = Math.max(1, ...nodes.map((entry) => entry.depth));
    const ring = Math.max(115, Math.min(190, 600 / maxDepth));
    const extent = ring * (maxDepth + 1);
    const view = Math.max(820, extent * 2 + 260);

    const circles = Array.from({ length: maxDepth }, (_, index) => {
      const radius = (index + 1) * ring;
      return `<circle class="radial-ring" cx="0" cy="0" r="${radius}"></circle>`;
    }).join("");

    const cladeArcs = nodes.filter((entry) => entry.depth > 0).map((entry) => {
      const path = cladeArcPath(entry, ring);
      if (!path) return "";
      return `<path class="radial-clade-arc depth-${entry.depth}" d="${path}"></path>`;
    }).join("");

    const edges = nodes.filter((entry) => entry.parent).map((entry) => {
      return `<path class="radial-edge depth-${entry.depth}" d="${branchPath(entry.parent, entry, ring)}"></path>`;
    }).join("");

    const nodeMarkup = nodes.map((entry) => {
      const p = polar(entry.angle, entry.depth * ring);
      const speciesCount = Number(entry.node.descendantSpeciesCount || 0);
      const directChildren = Number(entry.node.childCount || 0);
      const major = entry.depth <= 1 || speciesCount >= 1000 || directChildren > 20;
      const leaf = !entry.children.length && directChildren === 0;
      const label = entry.node.commonName || entry.node.canonicalName || entry.node.scientificName;
      const rank = entry.node.rank || entry.node.kind || "";
      const truncated = entry.node.truncatedChildren || entry.node.truncated || 0;
      const owned = Boolean(this.options.isOwned?.(entry.node));
      const priority = major ? "high" : entry.depth <= 2 ? "medium" : "low";
      return `
        <g class="radial-node priority-${priority} ${major ? "major" : ""} ${leaf ? "leaf" : ""} ${owned ? "owned" : ""}"
           data-radial-id="${escapeHtml(entry.node.id)}"
           transform="translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})">
          <circle class="radial-node-halo" r="${major ? 17 : 11}"></circle>
          <circle class="radial-node-dot" r="${major ? 6 : 4}"></circle>
          <text class="radial-node-label" x="${p.x >= 0 ? 13 : -13}" y="-2" text-anchor="${p.x >= 0 ? "start" : "end"}">${escapeHtml(label)}</text>
          <text class="radial-node-rank" x="${p.x >= 0 ? 13 : -13}" y="10" text-anchor="${p.x >= 0 ? "start" : "end"}">${escapeHtml(rank)}${speciesCount ? ` · ${speciesCount.toLocaleString()} spp` : ""}${truncated ? ` · +${truncated}` : ""}</text>
        </g>`;
    }).join("");

    const rootLabel = escapeHtml(payload.root.commonName || payload.root.scientificName);
    const rootOwned = Boolean(this.options.isOwned?.(payload.root));

    this.container.innerHTML = `
      <div class="radial-map-toolbar">
        <div class="radial-map-title"><span>FOCUS</span><b>${rootLabel}</b><small>${escapeHtml(payload.root.rank || "")}</small></div>
        <div class="radial-map-actions">
          <button data-radial-action="up" title="Parent">↑</button>
          <button data-radial-action="home" title="Origin / LUCA">◎</button>
          <button data-radial-action="out" title="Zoom out">−</button>
          <button data-radial-action="in" title="Zoom in">+</button>
          <button data-radial-action="reset" title="Reset view">⟲</button>
        </div>
      </div>
      <div class="radial-map-viewport">
        <svg class="radial-map-svg" viewBox="${-view / 2} ${-view / 2} ${view} ${view}" aria-label="Radial Tree of Life">
          <defs>
            <radialGradient id="radialGlow">
              <stop offset="0%" stop-color="#62ef9f" stop-opacity=".18"></stop>
              <stop offset="100%" stop-color="#62ef9f" stop-opacity="0"></stop>
            </radialGradient>
          </defs>
          <circle class="radial-aura" cx="0" cy="0" r="${ring * .85}"></circle>
          <g class="radial-viewport-group">
            <g class="radial-grid">${circles}</g>
            <g class="radial-clades">${cladeArcs}</g>
            <g class="radial-edges">${edges}</g>
            <g class="radial-nodes">${nodeMarkup}</g>
            <g class="radial-center ${rootOwned ? "owned" : ""}" data-radial-id="${escapeHtml(payload.root.id)}">
              <circle class="radial-center-orbit" r="37"></circle>
              <circle class="radial-center-core" r="22"></circle>
              <text y="-2">${rootLabel}</text>
              <text class="radial-center-rank" y="12">${escapeHtml(payload.root.rank || "")}</text>
            </g>
          </g>
        </svg>
        <div class="radial-tooltip"></div>
        <div class="radial-map-hint">Wheel to zoom · drag to move · click a branch to explore</div>
      </div>
    `;

    this.svg = this.container.querySelector(".radial-map-svg");
    this.group = this.container.querySelector(".radial-viewport-group");
    this.tooltip = this.container.querySelector(".radial-tooltip");
    this.wire(nodes);
    this.applyTransform();
  }

  wire(nodes) {
    const byId = new Map(nodes.map((entry) => [String(entry.node.id), entry.node]));

    this.container.querySelectorAll("[data-radial-id]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = element.dataset.radialId;
        const node = byId.get(String(id)) || (String(this.payload.root.id) === String(id) ? this.payload.root : null);
        if (!node) return;
        if (Number(node.childCount || 0) > 0 && String(node.id) !== String(this.payload.root.id)) {
          this.options.onFocus?.(node);
        } else {
          this.options.onSelect?.(node);
        }
      });
      element.addEventListener("pointerenter", (event) => {
        const id = element.dataset.radialId;
        const node = byId.get(String(id));
        if (!node || !this.tooltip) return;
        const speciesCount=Number(node.descendantSpeciesCount||0);
        const directChildren=Number(node.childCount||0);
        const scaleText=speciesCount
          ? `${speciesCount.toLocaleString()} species · ${directChildren.toLocaleString()} direct branches`
          : `${directChildren.toLocaleString()} direct branches`;
        this.tooltip.innerHTML = `<b>${escapeHtml(node.commonName || node.scientificName)}</b><em>${escapeHtml(node.scientificName)}</em><span>${escapeHtml(node.rank || "")} · ${scaleText}</span>`;
        this.tooltip.classList.add("visible");
        this.moveTooltip(event);
      });
      element.addEventListener("pointermove", (event) => this.moveTooltip(event));
      element.addEventListener("pointerleave", () => this.tooltip?.classList.remove("visible"));
    });

    this.container.querySelectorAll("[data-radial-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.radialAction;
        if (action === "in") this.zoom(1.2);
        if (action === "out") this.zoom(1 / 1.2);
        if (action === "reset") this.reset();
        if (action === "home") this.options.onHome?.();
        if (action === "up") this.options.onUp?.(this.payload);
      });
    });

    this.svg?.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    this.svg?.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("[data-radial-id]")) return;
      this.drag = { x: event.clientX, y: event.clientY, startX: this.x, startY: this.y };
      this.svg.setPointerCapture?.(event.pointerId);
      this.svg.classList.add("dragging");
    });
    this.svg?.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      this.x = this.drag.startX + (event.clientX - this.drag.x);
      this.y = this.drag.startY + (event.clientY - this.drag.y);
      this.applyTransform();
    });
    const endDrag = () => {
      this.drag = null;
      this.svg?.classList.remove("dragging");
    };
    this.svg?.addEventListener("pointerup", endDrag);
    this.svg?.addEventListener("pointercancel", endDrag);
  }

  moveTooltip(event) {
    if (!this.tooltip) return;
    const rect = this.container.getBoundingClientRect();
    this.tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${event.clientY - rect.top + 14}px`;
  }

  zoom(factor) {
    this.scale = Math.max(0.38, Math.min(4.5, this.scale * factor));
    this.applyTransform();
  }

  reset() {
    this.scale = 0.9;
    this.x = 0;
    this.y = 0;
    this.applyTransform();
  }

  applyTransform() {
    if (!this.group) return;
    this.group.style.transformOrigin = "center";
    this.group.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    if (this.svg) {
      this.svg.dataset.zoom = this.scale < 0.72 ? "far" : this.scale < 1.25 ? "mid" : "near";
    }
  }
}
