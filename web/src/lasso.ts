export type LassoPoint = { x: number; y: number }

function tracePath(context: CanvasRenderingContext2D, points: readonly LassoPoint[]) {
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) context.lineTo(point.x, point.y)
  context.closePath()
}

export function rasterizeLasso(
  context: CanvasRenderingContext2D, points: readonly LassoPoint[], width: number, height: number,
) {
  if (points.length < 3) return
  let left = width, top = height, right = 0, bottom = 0
  for (const { x, y } of points) {
    left = Math.min(left, Math.floor(x))
    top = Math.min(top, Math.floor(y))
    right = Math.max(right, Math.ceil(x))
    bottom = Math.max(bottom, Math.ceil(y))
  }
  const maskWidth = right - left
  const maskHeight = bottom - top
  if (maskWidth < 1 || maskHeight < 1) return
  context.canvas.width = maskWidth
  context.canvas.height = maskHeight
  context.translate(-left, -top)
  tracePath(context, points)
  context.fill('evenodd')
  return { left, top, width: maskWidth, height: maskHeight, pixels: context.getImageData(0, 0, maskWidth, maskHeight).data }
}

export class Lasso {
  private readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')
  private points: LassoPoint[] = []
  private cursor?: LassoPoint

  constructor(container: HTMLElement, private readonly preview: (points: readonly LassoPoint[], draftVertexCount?: number) => void) {
    this.canvas.className = 'lasso-overlay'
    this.canvas.hidden = true
    this.canvas.setAttribute('aria-hidden', 'true')
    container.append(this.canvas)
    this.canvas.addEventListener('click', event => {
      if (event.button !== 0) return
      const rect = this.canvas.getBoundingClientRect()
      if (!this.points.length) {
        this.canvas.width = Math.round(rect.width)
        this.canvas.height = Math.round(rect.height)
      }
      this.cursor = undefined
      this.points.push(this.position(event))
      this.drawOutline()
      this.preview(this.points, this.points.length)
    })
    this.canvas.addEventListener('pointermove', event => {
      if (!this.points.length) return
      this.cursor = this.position(event)
      this.drawOutline()
    })
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.cursor) return
      this.cursor = undefined
      this.drawOutline()
    })
    this.canvas.addEventListener('contextmenu', event => {
      event.preventDefault()
      this.finish()
    })
    new ResizeObserver(() => this.cancelDraft()).observe(container)
  }

  setActive(active: boolean) {
    if (!active) this.cancelDraft()
    this.canvas.hidden = !active
  }

  finish() {
    if (this.points.length < 3) return
    this.preview(this.points)
    this.clearOutline()
  }

  cancelDraft() {
    if (!this.points.length) return
    this.clearOutline()
    this.preview([])
  }

  private position(event: MouseEvent): LassoPoint {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(this.canvas.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(this.canvas.height, event.clientY - rect.top)),
    }
  }

  private previewPath() {
    return this.cursor ? [...this.points, this.cursor] : this.points
  }

  private drawOutline() {
    const context = this.context
    if (!context) return
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.fillStyle = 'rgba(255, 133, 200, 0.14)'
    context.strokeStyle = '#ff85c8'
    context.lineWidth = 2
    const path = this.previewPath()
    if (path.length >= 3) {
      tracePath(context, path)
      context.fill('evenodd')
    }
    context.beginPath()
    context.moveTo(this.points[0].x, this.points[0].y)
    for (const point of path.slice(1)) context.lineTo(point.x, point.y)
    context.stroke()
    context.fillStyle = '#ff85c8'
    for (const point of this.points) {
      context.beginPath()
      context.arc(point.x, point.y, 3, 0, 2 * Math.PI)
      context.fill()
    }
  }

  private clearOutline() {
    this.cursor = undefined
    this.points = []
    this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

}
