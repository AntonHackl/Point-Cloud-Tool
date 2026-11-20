import {
  BufferAttribute, BufferGeometry, GLSL3, IntType, NoBlending,
  PerspectiveCamera, Points, RawShaderMaterial, Scene, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export type Bounds = [[number, number, number], [number, number, number]]

const vertex = `
  precision highp float;
  precision highp int;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform float pointSize;
  in vec3 position;
  #ifdef PICKING
    flat out uint pointId;
  #else
    in vec3 color;
    in uint group;
    uniform bool useColors;
    uniform uint selectedGroup;
    out vec3 pointColor;
  #endif
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = pointSize;
    #ifdef PICKING
      pointId = uint(gl_VertexID) + 1u;
    #else
      pointColor = useColors ? color : vec3(0.55, 0.59, 0.62);
      if (selectedGroup != 0u) {
        pointColor = group == selectedGroup ? vec3(1.0, 0.83, 0.37) : pointColor * 0.40;
      }
    #endif
  }
`

const fragment = `
  precision highp float;
  precision highp int;
  #ifdef PICKING
    flat in uint pointId;
  #else
    in vec3 pointColor;
  #endif
  out vec4 outColor;
  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    if (dot(centered, centered) > 0.25) discard;
    #ifdef PICKING
      uvec4 bytes = (uvec4(pointId) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
      outColor = vec4(bytes) / 255.0;
    #else
      outColor = vec4(pointColor, 1.0);
    #endif
  }
`

export class Viewport {
  private readonly renderer = new WebGLRenderer({ alpha: false })
  private readonly camera = new PerspectiveCamera(48, 1, 0.01, 1000)
  private readonly scene = new Scene()
  private readonly pickScene = new Scene()
  private readonly controls: OrbitControls
  private readonly target = new WebGLRenderTarget(1, 1)
  private readonly display = this.material(false)
  private readonly picking = this.material(true)
  private readonly drawingSize = new Vector2()
  private readonly pivotMarker = document.createElement('div')
  private readonly projectedPivot = new Vector3()
  private geometry: BufferGeometry | undefined
  private points: Points | undefined
  private pickPoints: Points | undefined
  private radius = 1
  private frameRequested = false
  private pickQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly container: HTMLElement, onClick: (x: number, y: number) => void) {
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setClearColor(0x0d171d)
    this.renderer.domElement.setAttribute('aria-label', 'Point cloud canvas')
    this.pivotMarker.className = 'pivot-marker'
    this.pivotMarker.setAttribute('aria-hidden', 'true')
    this.pivotMarker.hidden = true
    container.append(this.renderer.domElement, this.pivotMarker)
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.draw())
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()

    const canvas = this.renderer.domElement
    let start: { x: number; y: number; id: number } | undefined
    let orbitPointer: number | undefined
    const touchPointers = new Set<number>()
    canvas.addEventListener('pointerdown', event => {
      this.pivotMarker.hidden = true
      start = event.button === 0 && event.isPrimary ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined
      if (event.pointerType === 'touch') {
        touchPointers.add(event.pointerId)
        orbitPointer = touchPointers.size === 1 ? event.pointerId : undefined
      } else {
        const modified = event.ctrlKey || event.metaKey || event.shiftKey
        const rotates = modified ? event.button === 2 : event.button === 0
        orbitPointer = rotates ? event.pointerId : undefined
      }
    })
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId !== orbitPointer) return
      orbitPointer = undefined
      if (!this.geometry) return
      this.anchorOrbit()
      this.pivotMarker.hidden = false
      this.draw()
    })
    const endOrbit = (event: PointerEvent) => {
      this.pivotMarker.hidden = true
      if (event.pointerType === 'touch') {
        touchPointers.delete(event.pointerId)
        orbitPointer = touchPointers.size === 1 ? touchPointers.values().next().value : undefined
      } else {
        orbitPointer = undefined
      }
    }
    canvas.addEventListener('pointercancel', event => {
      endOrbit(event)
      start = undefined
    })
    canvas.addEventListener('pointerup', event => {
      endOrbit(event)
      if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4) {
        onClick(event.clientX, event.clientY)
      }
      start = undefined
    })
  }

  private material(picking: boolean) {
    return new RawShaderMaterial({
      glslVersion: GLSL3,
      defines: picking ? { PICKING: 1 } : {},
      vertexShader: vertex,
      fragmentShader: fragment,
      blending: NoBlending,
      uniforms: {
        pointSize: { value: 3 },
        useColors: { value: false },
        selectedGroup: { value: 0 },
      },
    })
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(width, height)
    this.renderer.getDrawingBufferSize(this.drawingSize)
    this.display.uniforms.pointSize.value = 3 * ratio
    this.picking.uniforms.pointSize.value = 3 * ratio
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.draw()
  }

  setCloud(positions: Float32Array, bounds: Bounds, colors?: Uint8Array) {
    if (this.points) this.scene.remove(this.points)
    if (this.pickPoints) this.pickScene.remove(this.pickPoints)
    this.geometry?.dispose()
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3))
    const count = positions.length / 3
    this.geometry.setAttribute('color', new BufferAttribute(colors ?? new Uint8Array(positions.length), 3, true))
    this.geometry.setAttribute('group', this.groupAttribute(new Uint32Array(count)))
    this.display.uniforms.useColors.value = colors !== undefined
    this.display.uniforms.selectedGroup.value = 0
    this.points = new Points(this.geometry, this.display)
    this.pickPoints = new Points(this.geometry, this.picking)
    this.scene.add(this.points)
    this.pickScene.add(this.pickPoints)
    this.radius = Math.max(Math.hypot(...bounds[1].map((max, axis) => max - bounds[0][axis])) / 2, 0.001)
    this.reset()
  }

  reset() {
    const fov = Math.atan(Math.tan(this.camera.fov * Math.PI / 360) * Math.min(1, this.camera.aspect))
    const distance = this.radius * 1.12 / Math.sin(fov)
    this.camera.near = this.radius / 1000
    this.camera.far = distance + this.radius * 150
    this.camera.updateProjectionMatrix()
    this.controls.minDistance = this.radius / 80
    this.controls.maxDistance = this.radius * 100
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(new Vector3(1, -1, 0.8).normalize().multiplyScalar(distance))
    this.controls.update()
    this.draw()
  }

  setColors(colors?: Uint8Array) {
    if (colors && this.geometry) {
      const attribute = this.geometry.getAttribute('color')
      attribute.array.set(colors)
      attribute.needsUpdate = true
    }
    this.display.uniforms.useColors.value = colors !== undefined
    this.draw()
  }

  private groupAttribute(values: Uint32Array) {
    const attribute = new BufferAttribute(values, 1)
    attribute.gpuType = IntType
    return attribute
  }

  setGroups(groups: Uint32Array) {
    if (!this.geometry) return
    const attribute = this.geometry.getAttribute('group')
    attribute.array.set(groups)
    attribute.needsUpdate = true
    this.highlight(0)
  }

  highlight(group: number) {
    this.display.uniforms.selectedGroup.value = group
    this.draw()
  }

  private draw() {
    if (this.frameRequested) return
    this.frameRequested = true
    requestAnimationFrame(() => {
      this.frameRequested = false
      this.renderer.render(this.scene, this.camera)
      if (!this.pivotMarker.hidden) {
        this.projectedPivot.copy(this.controls.target).project(this.camera)
        this.pivotMarker.style.left = `${(this.projectedPivot.x + 1) * 50}%`
        this.pivotMarker.style.top = `${(1 - this.projectedPivot.y) * 50}%`
      }
    })
  }

  private anchorOrbit() {
    const positions = this.geometry?.getAttribute('position')
    if (!positions) return
    const width = this.drawingSize.x
    const height = this.drawingSize.y
    const centerX = (width - 1) / 2
    const centerY = (height - 1) / 2
    const pixelRatio = this.renderer.getPixelRatio()
    // Bridge small gaps in the cloud without snapping to distant points.
    const tolerance = Math.min(48 * pixelRatio, Math.max(4 * pixelRatio, Math.min(width, height) * 0.1))
    const x = Math.max(0, Math.ceil(centerX - tolerance))
    const y = Math.max(0, Math.ceil(centerY - tolerance))
    const columns = Math.min(width - x, Math.floor(centerX + tolerance) - x + 1)
    const rows = Math.min(height - y, Math.floor(centerY + tolerance) - y + 1)
    this.renderPickRegion(x, y, columns, rows)
    const bytes = new Uint8Array(columns * rows * 4)
    this.renderer.readRenderTargetPixels(this.target, x, y, columns, rows, bytes)

    const pixels = new DataView(bytes.buffer)
    let closest = tolerance * tolerance
    let point = 0
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const code = pixels.getUint32((row * columns + column) * 4, true)
        const distance = (x + column - centerX) ** 2 + (y + row - centerY) ** 2
        if (code === 0 || distance >= closest) continue
        closest = distance
        point = code
      }
    }
    if (point === 0) return

    this.controls.target.fromBufferAttribute(positions, point - 1)
    // Keep the current camera distance valid when the pivot moves to a new depth.
    const distance = this.camera.position.distanceTo(this.controls.target)
    this.controls.minDistance = Math.min(this.radius / 80, distance)
    this.controls.maxDistance = Math.max(this.radius * 100, distance)
  }

  private renderPickRegion(x: number, y: number, width: number, height: number) {
    this.target.setSize(this.drawingSize.x, this.drawingSize.y)
    this.target.scissor.set(x, y, width, height)
    this.target.scissorTest = true
    this.renderer.setRenderTarget(this.target)
    this.renderer.setClearColor(0, 0)
    try {
      this.renderer.render(this.pickScene, this.camera)
    } finally {
      this.renderer.setRenderTarget(null)
      this.renderer.setClearColor(0x0d171d, 1)
    }
  }

  pick(x: number, y: number): Promise<number | undefined> {
    const currentCloud = this.geometry
    const next = this.pickQueue.then(async () => {
      if (!currentCloud || currentCloud !== this.geometry) return
      const rect = this.renderer.domElement.getBoundingClientRect()
      const width = this.drawingSize.x
      const height = this.drawingSize.y
      const px = Math.floor((x - rect.left) * width / rect.width)
      const py = height - 1 - Math.floor((y - rect.top) * height / rect.height)
      if (px < 0 || py < 0 || px >= width || py >= height) return
      this.renderPickRegion(px, py, 1, 1)
      const bytes = new Uint8Array(4)
      await this.renderer.readRenderTargetPixelsAsync(this.target, px, py, 1, 1, bytes)
      const code = new DataView(bytes.buffer).getUint32(0, true)
      return code === 0 ? undefined : code - 1
    })
    this.pickQueue = next.catch(() => undefined)
    return next
  }
}
