import {
  BufferAttribute, BufferGeometry, CylinderGeometry, DynamicDrawUsage, GLSL3, Group, IntType, Matrix4, Mesh, MeshBasicMaterial, NoBlending,
  PerspectiveCamera, Points, Quaternion, RawShaderMaterial, Scene, SRGBColorSpace,
  SphereGeometry, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { rasterizeLasso, type LassoPoint } from './lasso'

export type Bounds = [[number, number, number], [number, number, number]]
type OrbitMouseStart = Pick<MouseEvent, 'button' | 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

const motionPointBudget = 850_000
const motionSettleMs = 30

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
    in float lassoSelected;
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
      if (lassoSelected > 0.5) pointColor = vec3(1.0, 0.42, 0.72);
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

function createPivotMarker() {
  const marker = new Group()
  const shaft = new CylinderGeometry(0.028, 0.028, 1, 8)
  const up = new Vector3(0, 1, 0)
  const axes = [
    { direction: new Vector3(1, 0, 0), color: 0xff826f },
    { direction: new Vector3(0, 1, 0), color: 0xa2e5d1 },
    { direction: new Vector3(0, 0, 1), color: 0x79baff },
  ]
  for (const { direction, color } of axes) {
    const arm = new Mesh(shaft, new MeshBasicMaterial({ color }))
    arm.quaternion.setFromUnitVectors(up, direction)
    arm.position.copy(direction).multiplyScalar(0.2)
    marker.add(arm)
  }
  marker.add(new Mesh(new SphereGeometry(0.08, 12, 8), new MeshBasicMaterial({ color: 0xfff4d5 })))
  marker.visible = false
  return marker
}

export class Viewport {
  private readonly renderer = new WebGLRenderer({ alpha: false })
  private readonly camera = new PerspectiveCamera(48, 1, 0.01, 1000)
  private readonly viewCamera = this.camera.clone()
  private readonly viewRotation = new Quaternion()
  private readonly scene = new Scene()
  private readonly pickScene = new Scene()
  private readonly controls: OrbitControls
  private readonly target = new WebGLRenderTarget(1, 1)
  private readonly display = this.material(false)
  private readonly picking = this.material(true)
  private readonly drawingSize = new Vector2()
  private readonly pivotMarker = createPivotMarker()
  private geometry: BufferGeometry | undefined
  private motionGeometry: BufferGeometry | undefined
  private readonly lassoMask = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  private lassoProjection?: {
    raster: NonNullable<ReturnType<typeof rasterizeLasso>>
    matrix: Matrix4['elements']
    width: number
    height: number
  }
  private lassoCount = 0
  private motionTimer: number | undefined
  private orbitRevision = 0
  private points: Points | undefined
  private pickPoints: Points | undefined
  private radius = 1
  private frameRequested = false
  private motionFrameRequested = false
  private lastMotionFrame: number | undefined
  private motionSampleStart = 0
  private motionFrameCount = 0
  private longestMotionFrame = 0
  private readonly motionHistory: number[] = []
  private readonly frameRateLabel: HTMLElement
  private readonly frameRateScale: HTMLElement
  private readonly frameRateBars: HTMLElement
  private pickQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly container: HTMLElement,
    private readonly frameRate: HTMLElement,
    onClick: (x: number, y: number) => void,
  ) {
    this.frameRateLabel = frameRate.querySelector<HTMLElement>('#frame-rate-label')!
    this.frameRateScale = frameRate.querySelector<HTMLElement>('#frame-rate-scale')!
    this.frameRateBars = frameRate.querySelector<HTMLElement>('#frame-rate-bars')!
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setClearColor(0x0d171d)
    this.renderer.domElement.setAttribute('aria-label', 'Point cloud canvas')
    container.append(this.renderer.domElement)
    this.scene.add(this.pivotMarker)
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.5
    this.controls.addEventListener('change', () => this.draw(true))
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()

    const canvas = this.renderer.domElement
    let start: { x: number; y: number; id: number } | undefined
    let orbit: { pointer: number; revision: number; started: boolean; point?: number } | undefined
    let mousePointer: number | undefined
    let mouseButtons: number[] = []
    const touchPointers = new Set<number>()
    const beginOrbit = (pointer?: number) => {
      orbit = undefined
      if (pointer === undefined || !this.geometry) return
      const gesture = { pointer, revision: this.orbitRevision, started: false, point: undefined as number | undefined }
      orbit = gesture
      void this.findOrbitPoint().then(point => {
        if (orbit !== gesture || gesture.revision !== this.orbitRevision || point === undefined) return
        gesture.point = point
        if (gesture.started) {
          this.setOrbitPivot(point)
          this.draw(true)
        }
      }).catch(() => {
        // Keep the existing pivot if the GPU lookup fails.
      })
    }
    const startMouseMode = (event: OrbitMouseStart, pointer: number) => {
      const modified = event.ctrlKey || event.metaKey || event.shiftKey
      const rotates = modified ? event.button === 2 : event.button === 0
      beginOrbit(rotates ? pointer : undefined)
    }
    const switchMouseMode = (event: MouseEvent, button: number) => {
      if (mousePointer === undefined || !this.controls.enabled) return
      start = undefined
      this.setPivotVisible(false)
      const mouse: OrbitMouseStart = {
        button, clientX: event.clientX, clientY: event.clientY,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      }
      // OrbitControls only handles the first pointerdown. Reuse its mouse-mode setup
      // to reset the drag origin when a second button takes over the same pointer.
      const controls = this.controls as OrbitControls & { _onMouseDown(event: OrbitMouseStart): void }
      controls._onMouseDown(mouse)
      startMouseMode(mouse, mousePointer)
    }
    canvas.addEventListener('pointerdown', event => {
      this.setPivotVisible(false)
      start = event.button === 0 && event.isPrimary ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined
      if (event.pointerType === 'touch') {
        touchPointers.add(event.pointerId)
        beginOrbit(touchPointers.size === 1 ? event.pointerId : undefined)
      } else {
        if (event.pointerType === 'mouse') {
          mousePointer = event.pointerId
          mouseButtons = [event.button]
        }
        startMouseMode(event, event.pointerId)
      }
    })
    window.addEventListener('mousedown', event => {
      if (mousePointer === undefined || event.button > 2 || mouseButtons.includes(event.button)) return
      mouseButtons.push(event.button)
      switchMouseMode(event, event.button)
    })
    window.addEventListener('mouseup', event => {
      if (mousePointer === undefined) return
      const previous = mouseButtons.at(-1)
      mouseButtons = mouseButtons.filter(button => button !== event.button)
      const current = mouseButtons.at(-1)
      if (current !== undefined && previous !== current) switchMouseMode(event, current)
    })
    canvas.addEventListener('pointermove', event => {
      if (!orbit || event.pointerId !== orbit.pointer || orbit.started || orbit.revision !== this.orbitRevision) return
      orbit.started = true
      if (orbit.point !== undefined) this.setOrbitPivot(orbit.point)
      this.setPivotVisible(true)
    })
    const endOrbit = (event: PointerEvent) => {
      this.setPivotVisible(false)
      if (event.pointerType === 'touch') {
        touchPointers.delete(event.pointerId)
        beginOrbit(touchPointers.size === 1 ? touchPointers.values().next().value : undefined)
      } else {
        orbit = undefined
        mousePointer = undefined
        mouseButtons = []
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
    this.orbitRevision++
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
    this.viewCamera.copy(this.camera)
    this.draw()
  }

  setCloud(positions: Float32Array, bounds: Bounds, colors?: Uint8Array) {
    if (this.points) this.scene.remove(this.points)
    if (this.pickPoints) this.pickScene.remove(this.pickPoints)
    this.motionGeometry?.dispose()
    this.geometry?.dispose()
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3))
    const count = positions.length / 3
    this.geometry.setAttribute('color', new BufferAttribute(colors ?? new Uint8Array(positions.length), 3, true))
    this.geometry.setAttribute('group', this.groupAttribute(new Uint32Array(count)))
    this.geometry.setAttribute('lassoSelected', new BufferAttribute(new Uint8Array(count), 1).setUsage(DynamicDrawUsage))
    this.lassoProjection = undefined
    this.lassoCount = 0
    this.motionGeometry = this.createMotionGeometry(this.geometry, count)
    this.display.uniforms.useColors.value = colors !== undefined
    this.display.uniforms.selectedGroup.value = 0
    this.points = new Points(this.geometry, this.display)
    this.pickPoints = new Points(this.geometry, this.picking)
    this.scene.add(this.points)
    this.pickScene.add(this.pickPoints)
    this.radius = Math.max(Math.hypot(...bounds[1].map((max, axis) => max - bounds[0][axis])) / 2, 0.001)
    this.motionHistory.length = 0
    this.frameRateBars.replaceChildren()
    this.frameRateScale.textContent = '60'
    this.frameRateLabel.textContent = 'Move view to measure FPS'
    this.frameRate.hidden = false
    this.reset()
  }

  private createMotionGeometry(full: BufferGeometry, pointCount: number) {
    if (pointCount <= motionPointBudget) return

    const stride = Math.ceil(pointCount / motionPointBudget)
    const indices = new Uint32Array(Math.ceil(pointCount / stride))
    for (let i = 0; i < indices.length; i++) {
      const start = i * stride
      const length = Math.min(stride, pointCount - start)
      // Vary the offset so periodically ordered scans don't produce a striped preview.
      const offset = (Math.imul(i + 1, 0x9e3779b1) >>> 16) % length
      indices[i] = start + offset
    }
    const preview = new BufferGeometry()
    for (const [name, attribute] of Object.entries(full.attributes)) preview.setAttribute(name, attribute)
    preview.setIndex(new BufferAttribute(indices, 1))
    full.computeBoundingSphere()
    preview.boundingSphere = full.boundingSphere
    return preview
  }

  reset() {
    this.orbitRevision++
    this.viewRotation.identity()
    // Consume any remaining drag momentum before applying the reset pose.
    this.controls.enableDamping = false
    this.controls.update()
    this.controls.enableDamping = true
    const fov = Math.atan(Math.tan(this.camera.fov * Math.PI / 360) * Math.min(1, this.camera.aspect))
    const distance = this.radius * 1.12 / Math.sin(fov)
    this.camera.near = this.radius / 1000
    this.camera.far = distance + this.radius * 150
    this.camera.updateProjectionMatrix()
    this.viewCamera.copy(this.camera)
    this.controls.minDistance = this.radius / 80
    this.controls.maxDistance = this.radius * 100
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(new Vector3(1, -1, 0.8).normalize().multiplyScalar(distance))
    this.controls.update()
    this.motionFrameRequested = false
    this.lastMotionFrame = undefined
    window.clearTimeout(this.motionTimer)
    this.motionTimer = undefined
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

  setLassoActive(active: boolean) {
    this.orbitRevision++
    this.controls.enabled = !active
    if (!active) return
    this.controls.enableDamping = false
    this.controls.update()
    this.controls.enableDamping = true
    this.setPivotVisible(false)
    this.motionFrameRequested = false
    this.lastMotionFrame = undefined
    window.clearTimeout(this.motionTimer)
    this.motionTimer = undefined
    this.draw()
  }

  previewLasso(path: readonly LassoPoint[], activeTreeOnly: boolean) {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const raster = this.lassoMask && rasterizeLasso(this.lassoMask, path, width, height)
    const camera = this.syncViewCamera()
    camera.updateMatrixWorld()
    this.lassoProjection = raster ? {
      raster, width, height,
      matrix: new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements,
    } : undefined
    return this.filterLasso(activeTreeOnly)
  }

  filterLasso(activeTreeOnly: boolean) {
    if (!this.geometry) return 0
    const attribute = this.geometry.getAttribute('lassoSelected')
    const selected = attribute.array
    if (this.lassoCount) selected.fill(0)
    let count = 0
    if (this.lassoProjection) {
      const { raster, matrix, width, height } = this.lassoProjection
      const xyz = this.geometry.getAttribute('position').array
      const groups = this.geometry.getAttribute('group').array
      const group = this.display.uniforms.selectedGroup.value
      for (let i = 0; i < selected.length; i++) {
        if (activeTreeOnly && (group === 0 || groups[i] !== group)) continue
        const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2]
        const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
        if (w <= 0) continue
        const screenX = ((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w + 1) * width / 2
        const column = Math.floor(screenX) - raster.left
        if (column < 0 || column >= raster.width) continue
        const screenY = (1 - (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) * height / 2
        const row = Math.floor(screenY) - raster.top
        if (row < 0 || row >= raster.height || raster.pixels[(row * raster.width + column) * 4 + 3] < 128) continue
        const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
        if (clipZ < -w || clipZ > w) continue
        selected[i] = 1
        count++
      }
    }
    if (count || this.lassoCount) {
      attribute.needsUpdate = true
      this.draw()
    }
    this.lassoCount = count
    return count
  }

  private setPivotVisible(visible: boolean) {
    if (this.pivotMarker.visible === visible) return
    this.pivotMarker.visible = visible
    this.draw()
  }

  private draw(cameraMoved = false) {
    this.motionFrameRequested ||= cameraMoved && this.geometry !== undefined
    if (this.frameRequested) return
    this.frameRequested = true
    requestAnimationFrame(time => {
      // Keep easing between input events, with no animation loop once the camera settles.
      const cameraAdvanced = this.controls.enabled && this.controls.update()
      this.frameRequested = false
      if (this.motionFrameRequested && this.motionGeometry) {
        window.clearTimeout(this.motionTimer)
        this.motionTimer = window.setTimeout(() => {
          this.motionTimer = undefined
          this.draw()
        }, motionSettleMs)
      }
      if (this.points && this.geometry) {
        this.points.geometry = this.motionTimer === undefined
          ? this.geometry
          : this.motionGeometry ?? this.geometry
      }
      if (this.pivotMarker.visible) {
        this.pivotMarker.position.copy(this.controls.target)
        const distance = this.camera.position.distanceTo(this.controls.target)
        const viewHeight = 2 * distance * Math.tan(this.camera.fov * Math.PI / 360)
        const screenHeight = this.drawingSize.y / this.renderer.getPixelRatio()
        this.pivotMarker.scale.setScalar(52 * viewHeight / screenHeight)
      }
      this.renderer.render(this.scene, this.syncViewCamera())
      if (this.motionFrameRequested) this.recordMotionFrame(time)
      this.motionFrameRequested = false
      if (cameraAdvanced) this.draw()
    })
  }

  private recordMotionFrame(time: number) {
    const previous = this.lastMotionFrame
    this.lastMotionFrame = time
    // The viewer draws on demand. Start a fresh sample after motion pauses.
    if (previous === undefined || time - previous > 500) {
      this.motionSampleStart = time
      this.motionFrameCount = 0
      this.longestMotionFrame = 0
      return
    }

    this.motionFrameCount++
    this.longestMotionFrame = Math.max(this.longestMotionFrame, time - previous)
    const elapsed = time - this.motionSampleStart
    if (elapsed < 250) return

    const fps = Math.round(this.motionFrameCount * 1000 / elapsed)
    const maxFrame = this.longestMotionFrame.toFixed(1)
    this.frameRateLabel.textContent = `${fps} FPS · ${maxFrame} ms max`
    this.motionHistory.push(fps)
    if (this.motionHistory.length > 40) this.motionHistory.shift()
    const ceiling = Math.max(60, Math.ceil(Math.max(...this.motionHistory) / 60) * 60)
    this.frameRateScale.textContent = String(ceiling)
    this.frameRateBars.replaceChildren(...this.motionHistory.map(value => {
      const bar = document.createElement('span')
      bar.style.height = `${value / ceiling * 100}%`
      return bar
    }))
    this.motionSampleStart = time
    this.motionFrameCount = 0
    this.longestMotionFrame = 0
  }

  private async findOrbitPoint() {
    const cloud = this.geometry
    const revision = this.orbitRevision
    const camera = this.syncViewCamera().clone()
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
    const bytes = await this.queuePick(() => {
      if (cloud !== this.geometry || revision !== this.orbitRevision) return
      return this.readPickRegion(x, y, columns, rows, camera)
    })
    if (!bytes) return

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
    return point === 0 ? undefined : point - 1
  }

  private setOrbitPivot(point: number) {
    const positions = this.geometry?.getAttribute('position')
    if (!positions) return
    const previousAim = this.syncViewCamera().quaternion
    this.controls.target.fromBufferAttribute(positions, point)
    // OrbitControls aims its camera at the pivot. Carry the current viewing
    // direction as a local rotation so changing the pivot can't reframe the shot.
    this.camera.lookAt(this.controls.target)
    this.viewRotation.copy(this.camera.quaternion).invert().multiply(previousAim)
    // Keep the current camera distance valid when the pivot moves to a new depth.
    const distance = this.camera.position.distanceTo(this.controls.target)
    this.controls.minDistance = Math.min(this.radius / 80, distance)
    this.controls.maxDistance = Math.max(this.radius * 100, distance)
  }

  private syncViewCamera() {
    this.viewCamera.position.copy(this.camera.position)
    this.viewCamera.quaternion.copy(this.camera.quaternion).multiply(this.viewRotation)
    return this.viewCamera
  }

  private async readPickRegion(x: number, y: number, width: number, height: number, camera = this.syncViewCamera()) {
    this.target.setSize(this.drawingSize.x, this.drawingSize.y)
    this.target.scissor.set(x, y, width, height)
    this.target.scissorTest = true
    this.renderer.setRenderTarget(this.target)
    this.renderer.setClearColor(0, 0)
    try {
      this.renderer.render(this.pickScene, camera)
    } finally {
      this.renderer.setRenderTarget(null)
      this.renderer.setClearColor(0x0d171d, 1)
    }
    const bytes = new Uint8Array(width * height * 4)
    return this.renderer.readRenderTargetPixelsAsync(this.target, x, y, width, height, bytes)
  }

  private queuePick<T>(read: () => Promise<T> | undefined) {
    const next = this.pickQueue.then(read)
    this.pickQueue = next.catch(() => undefined)
    return next
  }

  pick(x: number, y: number): Promise<number | undefined> {
    const currentCloud = this.geometry
    return this.queuePick(async () => {
      if (!currentCloud || currentCloud !== this.geometry) return
      const rect = this.renderer.domElement.getBoundingClientRect()
      const width = this.drawingSize.x
      const height = this.drawingSize.y
      const px = Math.floor((x - rect.left) * width / rect.width)
      const py = height - 1 - Math.floor((y - rect.top) * height / rect.height)
      if (px < 0 || py < 0 || px >= width || py >= height) return
      const bytes = await this.readPickRegion(px, py, 1, 1)
      const code = new DataView(bytes.buffer).getUint32(0, true)
      return code === 0 ? undefined : code - 1
    })
  }
}
