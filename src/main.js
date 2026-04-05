import './style.css'
import { graphData } from './graph-data.js'

const svgWidth = 1180
const svgHeight = 980
const centerX = svgWidth / 2
const centerY = svgHeight / 2
const initialView = { x: 0, y: 0, width: svgWidth, height: svgHeight }
const canvasBounds = {
  minX: -180,
  maxX: svgWidth + 180,
  minY: -120,
  maxY: svgHeight + 160,
}

const themePalette = { default: '#3d5a80' }
const paletteList = ['#e76f51', '#c8553d', '#e9c46a', '#bc6c25', '#2a9d8f', '#ef476f', '#118ab2', '#3d5a80', '#6d597a']
const themeOrder = [...new Set(graphData.nodes.map((node) => node.theme))]
const gradeOrder = [...new Set(graphData.nodes.map((node) => node.grade))]

themeOrder.forEach((theme, index) => {
  themePalette[theme] = paletteList[index % paletteList.length]
})

const nodes = graphData.nodes.map((node, index) => ({
  ...node,
  shortLabel: node.label.replaceAll('„', '').replaceAll('“', ''),
  color: themePalette[node.theme] ?? themePalette.default,
  badge: index + 1,
  index,
}))

const edgeMap = new Map()
const adjacency = new Map(nodes.map((node) => [node.id, []]))

graphData.edges.forEach((edge, index) => {
  const key = edgeKey(edge.source, edge.target)
  const enrichedEdge = { ...edge, key, index }
  edgeMap.set(key, enrichedEdge)
  adjacency.get(edge.source).push(enrichedEdge)
  adjacency.get(edge.target).push(enrichedEdge)
})

const positions = createNodePositions(nodes)

const state = {
  grade: 'all',
  themes: [...themeOrder],
  selectedNodeId: null,
  selectedEdgeKey: null,
  hoveredNodeId: null,
  view: { ...initialView },
  drag: null,
}

const app = document.querySelector('#app')
renderShell()
bindEvents()
render()

function renderShell() {
  app.innerHTML = `
    <div class="page-shell">
      <main class="workspace">
        <aside class="filters-panel">
          <div class="panel-header panel-header-stack">
            <div>
              <h2>Филтри</h2>
            </div>
          </div>
          <div class="toolbar-block">
            <span class="toolbar-label">Клас</span>
            <div class="chip-row" id="grade-filters"></div>
          </div>
          <div class="toolbar-block">
            <span class="toolbar-label">Теми</span>
            <div class="chip-row" id="theme-filters"></div>
          </div>
          <label class="search-box">
            <span>Избери произведение</span>
            <select id="work-select"></select>
          </label>
        </aside>

        <section class="graph-panel">
          <div class="panel-header">
            <div>
              <h2>Мрежа на литературните връзки</h2>
            </div>
            <div class="graph-actions">
              <button class="ghost-button" id="reset-view" type="button">Нулирай изгледа</button>
              <button class="ghost-button" id="clear-selection" type="button">Изчисти избора</button>
            </div>
          </div>
          <div class="graph-stage" id="graph-stage">
            <svg id="graph-svg" role="img" aria-label="Мрежа на литературни произведения и техните връзки"></svg>
            <div class="legend-grid" id="theme-legend"></div>
          </div>
        </section>

        <aside class="detail-panel" id="detail-panel"></aside>
      </main>
    </div>
  `
}

function bindEvents() {
  app.addEventListener('click', (event) => {
    const filterAction = event.target.closest('[data-filter-action]')
    if (filterAction?.dataset.filterAction === 'toggle-all-themes') {
      state.themes = state.themes.length === themeOrder.length ? [] : [...themeOrder]
      resetSelectionIfHidden()
      render()
      return
    }

    const chip = event.target.closest('[data-filter]')
    if (chip) {
      if (chip.dataset.filter === 'theme') {
        toggleTheme(chip.dataset.value)
      } else {
        state[chip.dataset.filter] = chip.dataset.value
      }
      resetSelectionIfHidden()
      render()
      return
    }

    const nodeButton = event.target.closest('[data-node-id]')
    if (nodeButton) {
      handleNodeSelection(Number(nodeButton.dataset.nodeId))
      render()
      return
    }

    if (event.target.closest('#clear-selection')) {
      clearSelection()
      render()
      return
    }

    if (event.target.closest('#reset-view')) {
      state.view = { ...initialView }
      render()
    }
  })

  app.addEventListener('change', (event) => {
    if (event.target.id !== 'work-select') {
      return
    }

    if (!event.target.value) {
      clearSelection()
      render()
      return
    }

    state.selectedNodeId = Number(event.target.value)
    state.selectedEdgeKey = null
    render()
  })

  const stage = document.querySelector('#graph-stage')

  stage.addEventListener('wheel', (event) => {
    event.preventDefault()

    const rect = stage.getBoundingClientRect()
    const pointerX = state.view.x + ((event.clientX - rect.left) / rect.width) * state.view.width
    const pointerY = state.view.y + ((event.clientY - rect.top) / rect.height) * state.view.height
    const zoomFactor = event.deltaY < 0 ? 0.9 : 1.1
    const nextWidth = clamp(state.view.width * zoomFactor, svgWidth * 0.58, svgWidth * 1.35)
    const nextHeight = clamp(state.view.height * zoomFactor, svgHeight * 0.58, svgHeight * 1.35)
    const scaleX = nextWidth / state.view.width
    const scaleY = nextHeight / state.view.height

    state.view = constrainView({
      x: pointerX - (pointerX - state.view.x) * scaleX,
      y: pointerY - (pointerY - state.view.y) * scaleY,
      width: nextWidth,
      height: nextHeight,
    })

    render()
  }, { passive: false })

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return
    }

    if (event.target.closest('[data-node-id], button, select')) {
      return
    }

    stage.setPointerCapture(event.pointerId)
    stage.classList.add('is-dragging')
    state.hoveredNodeId = null
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...state.view },
      edgeKey: event.target.closest('[data-edge-key]')?.dataset.edgeKey ?? null,
      moved: false,
    }
  })

  stage.addEventListener('pointermove', (event) => {
    if (state.drag && state.drag.pointerId === event.pointerId) {
      const rect = stage.getBoundingClientRect()
      const deltaX = ((event.clientX - state.drag.startX) / rect.width) * state.drag.origin.width
      const deltaY = ((event.clientY - state.drag.startY) / rect.height) * state.drag.origin.height

      if (Math.abs(event.clientX - state.drag.startX) > 3 || Math.abs(event.clientY - state.drag.startY) > 3) {
        state.drag.moved = true
      }

      state.view = constrainView({
        ...state.drag.origin,
        x: state.drag.origin.x - deltaX,
        y: state.drag.origin.y - deltaY,
      })

      render()
      return
    }

    const hoveredNodeId = event.target.closest('.node-hit')?.dataset.nodeId ?? null
    const nextHoveredNodeId = hoveredNodeId === null ? null : Number(hoveredNodeId)
    if (state.hoveredNodeId !== nextHoveredNodeId) {
      state.hoveredNodeId = nextHoveredNodeId
      render()
    }
  })

  const endDrag = (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) {
      return
    }

    stage.classList.remove('is-dragging')
    if (!state.drag.moved && state.drag.edgeKey) {
      state.selectedEdgeKey = state.selectedEdgeKey === state.drag.edgeKey ? null : state.drag.edgeKey
      state.selectedNodeId = null
      render()
    }
    state.drag = null
  }

  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  stage.addEventListener('pointerleave', () => {
    if (state.hoveredNodeId !== null && !state.drag) {
      state.hoveredNodeId = null
      render()
    }
  })
}

function render() {
  const visibleNodes = getVisibleNodes()
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id))
  const visibleEdges = [...edgeMap.values()].filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))

  renderGradeFilters()
  renderThemeFilters()
  renderSelect(visibleNodes)
  renderLegend()
  renderGraph(visibleNodes, visibleEdges)
  renderDetails(visibleNodes, visibleNodeIds)
}

function renderGradeFilters() {
  renderFilters(
    'grade-filters',
    [{ label: 'Всички', value: 'all' }, ...gradeOrder.map((grade) => ({ label: grade, value: grade }))],
    (value) => value === state.grade,
    'grade',
  )
}

function renderThemeFilters() {
  const target = document.querySelector('#theme-filters')
  const allSelected = state.themes.length === themeOrder.length

  target.innerHTML = `
    <button
      type="button"
      class="chip ${allSelected ? 'is-active' : ''}"
      data-filter-action="toggle-all-themes"
    >
      Всички теми
    </button>
    ${themeOrder
      .map((theme) => `
        <button
          type="button"
          class="chip ${state.themes.includes(theme) ? 'is-active' : ''}"
          data-filter="theme"
          data-value="${escapeAttribute(theme)}"
        >
          ${escapeHtml(theme)}
        </button>
      `)
      .join('')}
  `
}

function renderFilters(targetId, items, isActive, filterName) {
  const target = document.querySelector(`#${targetId}`)
  target.innerHTML = items
    .map((item) => `
      <button
        type="button"
        class="chip ${isActive(item.value) ? 'is-active' : ''}"
        data-filter="${filterName}"
        data-value="${escapeAttribute(item.value)}"
      >
        ${escapeHtml(item.label)}
      </button>
    `)
    .join('')
}

function renderSelect(visibleNodes) {
  const select = document.querySelector('#work-select')
  const selectedValue = state.selectedNodeId === null ? '' : String(state.selectedNodeId)
  select.innerHTML = `
    <option value="">Избери произведение</option>
    ${visibleNodes
      .map((node) => `
        <option value="${node.id}" ${selectedValue === String(node.id) ? 'selected' : ''}>
          ${node.badge}. ${escapeHtml(node.shortLabel)} · ${escapeHtml(node.theme)}
        </option>
      `)
      .join('')}
  `
}

function renderLegend() {
  const legend = document.querySelector('#theme-legend')
  legend.innerHTML = themeOrder
    .map((theme) => `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${themePalette[theme]}"></span>
        <span>${escapeHtml(theme)}</span>
      </div>
    `)
    .join('')
}

function renderGraph(visibleNodes, visibleEdges) {
  const svg = document.querySelector('#graph-svg')
  const selectedEdge = state.selectedEdgeKey ? edgeMap.get(state.selectedEdgeKey) : null
  const selectedNodeId = state.selectedNodeId
  const hoveredNode = state.hoveredNodeId === null ? null : visibleNodes.find((node) => node.id === state.hoveredNodeId)

  svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`)

  const ringMarkup = [280, 360]
    .map((radius, index) => `
      <circle
        cx="${centerX}"
        cy="${centerY}"
        r="${radius}"
        class="orbit-ring ${index === 0 ? 'inner' : 'outer'}"
      ></circle>
    `)
    .join('')

  const edgesMarkup = visibleEdges
    .map((edge) => {
      const source = positions.get(edge.source)
      const target = positions.get(edge.target)
      const isSelectedEdge = selectedEdge?.key === edge.key
      const isConnectedToNode = selectedNodeId !== null && (edge.source === selectedNodeId || edge.target === selectedNodeId)
      const classes = ['edge-line', isSelectedEdge ? 'is-selected' : '', !selectedEdge && isConnectedToNode ? 'is-linked' : '']
        .filter(Boolean)
        .join(' ')

      return `
        <line
          x1="${source.x}"
          y1="${source.y}"
          x2="${target.x}"
          y2="${target.y}"
          class="${classes}"
          data-edge-key="${edge.key}"
        ></line>
      `
    })
    .join('')

  const nodesMarkup = visibleNodes
    .map((node) => {
      const position = positions.get(node.id)
      const isSelectedNode = selectedNodeId === node.id
      const isDimmed = selectedEdge && node.id !== selectedEdge.source && node.id !== selectedEdge.target
      const connected = selectedNodeId !== null && selectedNodeId !== node.id ? edgeMap.has(edgeKey(selectedNodeId, node.id)) : false

      return `
        <g class="node-group ${isSelectedNode ? 'is-selected' : ''} ${connected && !selectedEdge ? 'is-connected' : ''} ${isDimmed ? 'is-dimmed' : ''}">
          <circle
            cx="${position.x}"
            cy="${position.y}"
            r="${node.grade === gradeOrder[0] ? 16 : 18}"
            fill="${node.color}"
            stroke="${node.grade === gradeOrder[0] ? '#f7f1e3' : '#132238'}"
            stroke-width="3"
          ></circle>
          <circle
            cx="${position.x}"
            cy="${position.y}"
            r="26"
            class="node-hit"
            data-node-id="${node.id}"
          ></circle>
        </g>
      `
    })
    .join('')

  svg.innerHTML = `
    <rect class="graph-backdrop" x="${canvasBounds.minX}" y="${canvasBounds.minY}" width="${canvasBounds.maxX - canvasBounds.minX}" height="${canvasBounds.maxY - canvasBounds.minY}" rx="36"></rect>
    ${ringMarkup}
    <g class="edges">${edgesMarkup}</g>
    <g class="nodes">${nodesMarkup}</g>
    ${hoveredNode ? renderNodeTooltip(hoveredNode) : ''}
  `
}

function renderDetails(visibleNodes, visibleNodeIds) {
  const panel = document.querySelector('#detail-panel')
  const selectedEdge = state.selectedEdgeKey ? edgeMap.get(state.selectedEdgeKey) : null

  if (selectedEdge) {
    const source = nodes.find((node) => node.id === selectedEdge.source)
    const target = nodes.find((node) => node.id === selectedEdge.target)

    panel.innerHTML = `
      <div class="panel-header panel-header-stack">
        <div>
          <p class="panel-kicker">Избрана връзка</p>
          <h2>${escapeHtml(source.shortLabel)} ↔ ${escapeHtml(target.shortLabel)}</h2>
        </div>
      </div>
      <div class="detail-card emphasized">
        <p class="detail-label">Обща тема/мотив</p>
        <p class="edge-quote">${escapeHtml(selectedEdge.label)}</p>
      </div>
      <div class="pair-grid">
        ${nodeCard(source)}
        ${nodeCard(target)}
      </div>
      <button type="button" class="ghost-button full-width" id="clear-selection">Назад към мрежата</button>
    `
    return
  }

  if (state.selectedNodeId !== null) {
    const selectedNode = nodes.find((node) => node.id === state.selectedNodeId)
    const relations = adjacency
      .get(selectedNode.id)
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .map((edge) => {
        const otherId = edge.source === selectedNode.id ? edge.target : edge.source
        return {
          edge,
          otherNode: nodes.find((node) => node.id === otherId),
        }
      })
      .sort((left, right) => {
        if (left.otherNode.theme !== right.otherNode.theme) {
          return left.otherNode.theme.localeCompare(right.otherNode.theme, 'bg')
        }
        return left.otherNode.index - right.otherNode.index
      })

    panel.innerHTML = `
      <div class="panel-header panel-header-stack">
        <div>
          <p class="panel-kicker">Избрано произведение</p>
          <h2>${escapeHtml(selectedNode.shortLabel)}</h2>
        </div>
      </div>
      <div class="detail-card hero-detail">
        <p class="detail-label">${escapeHtml(selectedNode.grade)} · ${escapeHtml(selectedNode.theme)}</p>
        <p>
          Това произведение има <strong>${relations.length}</strong> видими връзки в текущия филтър.
          Връзките са подредени по теми, за да се намират по-лесно.
        </p>
      </div>
      <div class="section-list">
        ${renderSectionList(
          groupBy(relations, ({ otherNode }) => otherNode.theme),
          (theme, items) => `
            <section class="list-section">
              <h3 class="section-title">${escapeHtml(theme)} <span>${items.length}</span></h3>
              <div class="section-items">
                ${items
                  .map(({ edge, otherNode }) => `
                    <button type="button" class="relation-item" data-node-id="${otherNode.id}">
                      <span class="relation-target">
                        <span class="relation-dot" style="background:${otherNode.color}"></span>
                        ${escapeHtml(otherNode.shortLabel)}
                      </span>
                      <span class="relation-text">${escapeHtml(edge.label)}</span>
                    </button>
                  `)
                  .join('')}
              </div>
            </section>
          `,
        )}
      </div>
    `
    return
  }

  panel.innerHTML = `
    <div class="panel-header panel-header-stack">
      <div>
        <h2>Изберете възел или ръб, за да фокусирате мрежата</h2>
      </div>
    </div>
    <div class="detail-card">
      <p class="detail-label">Навигация</p>
      <p>Завъртането на колелцето увеличава и намалява, а влаченето с мишката мести изгледа. Клик върху произведение осветява връзките му.</p>
    </div>
    <div class="detail-card">
      <p>Цветовете следват темите от таблицата. Вътрешният пръстен е за първата група произведения, а външният за втората.</p>
    </div>
    <div class="section-list">
      ${renderSectionList(
        groupBy(visibleNodes, (node) => `${node.grade} · ${node.theme}`),
        (sectionTitle, items) => `
          <section class="list-section">
            <h3 class="section-title">${escapeHtml(sectionTitle)} <span>${items.length}</span></h3>
            <div class="section-items compact">
              ${items
                .map((node) => `
                  <button type="button" class="mini-node" data-node-id="${node.id}">
                    <span class="relation-dot" style="background:${node.color}"></span>
                    ${escapeHtml(node.shortLabel)}
                  </button>
                `)
                .join('')}
            </div>
          </section>
        `,
      )}
    </div>
  `
}

function createNodePositions(allNodes) {
  const groupedByTheme = new Map(themeOrder.map((theme) => [theme, []]))
  const map = new Map()

  allNodes.forEach((node) => {
    groupedByTheme.get(node.theme).push(node)
  })

  themeOrder.forEach((theme, themeIndex) => {
    const group = groupedByTheme.get(theme)
    const baseAngle = (Math.PI * 2 * themeIndex) / themeOrder.length - Math.PI / 2
    const spread = 0.18

    group.forEach((node, nodeIndex) => {
      const offset = (nodeIndex - (group.length - 1) / 2) * spread
      const radius = node.grade === gradeOrder[0] ? 280 : 360
      const angle = baseAngle + offset

      map.set(node.id, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        angle,
      })
    })
  })

  return map
}

function getVisibleNodes() {
  return nodes.filter((node) => {
    const gradeMatches = state.grade === 'all' || node.grade === state.grade
    const themeMatches = state.themes.includes(node.theme)
    return gradeMatches && themeMatches
  })
}

function renderNodeTooltip(node) {
  const position = positions.get(node.id)
  const width = 240
  const height = 62
  const sideRight = position.x < centerX
  const x = clamp(position.x + (sideRight ? 24 : -width - 24), canvasBounds.minX + 12, canvasBounds.maxX - width - 12)
  const y = clamp(position.y - height / 2, canvasBounds.minY + 12, canvasBounds.maxY - height - 12)
  const anchorX = sideRight ? x : x + width

  return `
    <g class="hover-tooltip">
      <path d="M ${position.x} ${position.y} C ${position.x + (sideRight ? 24 : -24)} ${position.y}, ${anchorX} ${y + height / 2}, ${anchorX} ${y + height / 2}" class="label-stem"></path>
      <foreignObject x="${x}" y="${y}" width="${width}" height="${height}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="node-label is-hovered">
          <span class="node-grade">${node.badge}. ${escapeHtml(node.grade)}</span>
          <strong>${escapeHtml(node.shortLabel)}</strong>
        </div>
      </foreignObject>
    </g>
  `
}

function constrainView(view) {
  return {
    ...view,
    x: clamp(view.x, canvasBounds.minX, canvasBounds.maxX - view.width),
    y: clamp(view.y, canvasBounds.minY, canvasBounds.maxY - view.height),
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function handleNodeSelection(nodeId) {
  if (state.selectedNodeId === nodeId) {
    clearSelection()
    return
  }

  if (state.selectedNodeId !== null && state.selectedNodeId !== nodeId) {
    state.selectedEdgeKey = edgeKey(state.selectedNodeId, nodeId)
    state.selectedNodeId = null
    return
  }

  state.selectedEdgeKey = null
  state.selectedNodeId = nodeId
}

function resetSelectionIfHidden() {
  const visibleNodeIds = new Set(getVisibleNodes().map((node) => node.id))

  if (state.selectedNodeId !== null && !visibleNodeIds.has(state.selectedNodeId)) {
    state.selectedNodeId = null
  }

  if (state.selectedEdgeKey) {
    const edge = edgeMap.get(state.selectedEdgeKey)
    if (!edge || !visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) {
      state.selectedEdgeKey = null
    }
  }
}

function clearSelection() {
  state.selectedNodeId = null
  state.selectedEdgeKey = null
}

function toggleTheme(theme) {
  state.themes = state.themes.includes(theme)
    ? state.themes.filter((entry) => entry !== theme)
    : [...state.themes, theme]
}

function edgeKey(source, target) {
  return source < target ? `${source}-${target}` : `${target}-${source}`
}

function nodeCard(node) {
  return `
    <article class="detail-card">
      <p class="detail-label">${escapeHtml(node.grade)} · ${escapeHtml(node.theme)}</p>
      <h3>${escapeHtml(node.shortLabel)}</h3>
    </article>
  `
}

function groupBy(items, keySelector) {
  const groups = new Map()

  items.forEach((item) => {
    const key = keySelector(item)
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(item)
  })

  return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0], 'bg'))
}

function renderSectionList(groups, renderSection) {
  return groups.map(([title, items]) => renderSection(title, items)).join('')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value)
}
