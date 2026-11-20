import './style.css'
import { Viewport, type Bounds } from './viewport'

type Field = { id: number; name: string; categorical: boolean }
type Cloud = { id: number; name: string; pointCount: number; bounds: Bounds; hasRgb: boolean; fields: Field[] }
type Selection = { point: number; group: number; label: string | null; pointCount: number }

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = element<HTMLInputElement>('file')
const open = element<HTMLButtonElement>('open')
const reset = element<HTMLButtonElement>('reset')
const color = element<HTMLSelectElement>('color')
const scale = element<HTMLSelectElement>('scale')
const instanceField = element<HTMLSelectElement>('instance-field')
const viewportContainer = element('viewport')
const counts = new Intl.NumberFormat()

let cloud: Cloud | undefined
let viewport: Viewport
let opening = false
let activeField: number | undefined
let colorRequest = 0
let groupRequest = 0
let pickRequest = 0

try {
  viewport = new Viewport(viewportContainer, (x, y) => { void selectPoint(x, y) })
  open.addEventListener('click', () => input.click())
  reset.addEventListener('click', () => viewport.reset())
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.value = ''
    if (file) void openFile(file)
  })
  color.addEventListener('change', () => {
    const field = cloud?.fields.find(field => String(field.id) === color.value)
    element('scale-control').hidden = !field
    if (field) scale.value = field.categorical ? 'categories' : 'gradient'
    void updateColors()
  })
  scale.addEventListener('change', () => { void updateColors() })
  instanceField.addEventListener('change', () => { void updateInstanceField() })
} catch {
  open.disabled = true
  status('WebGL 2 is unavailable. Open the viewer in a browser with hardware acceleration enabled.', true)
}

function status(message = '', error = false) {
  const output = element('status')
  output.textContent = message
  output.dataset.error = String(error)
}

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) {
    const data = await response.json().catch(() => undefined)
    throw new Error(data?.error ?? 'The local server could not complete the request.')
  }
  return response
}

async function buffer(url: string, byteLength: number) {
  const bytes = await (await request(url)).arrayBuffer()
  if (bytes.byteLength !== byteLength) throw new Error('The server returned an incomplete point buffer.')
  return bytes
}

function report(error: unknown) {
  status(error instanceof Error ? error.message : 'Something went wrong.', true)
}

function controls() {
  open.disabled = opening
  reset.disabled = color.disabled = scale.disabled = instanceField.disabled = !cloud || opening
}

function cloudUrl(dataset: Cloud) {
  return '/api/clouds/' + dataset.id
}

function clearSelection(label = 'No instance selected') {
  viewport.highlight(0)
  element('selected-label').textContent = label
  element('selected-count').textContent = ''
}

async function openFile(file: File) {
  if (opening) return
  const start = performance.now()
  opening = true
  pickRequest++
  controls()
  status('Opening ' + file.name + '…')
  try {
    const form = new FormData()
    form.set('file', file)
    const response = await request('/api/clouds', { method: 'POST', body: form })
    const dataset: Cloud = await response.json()
    const url = cloudUrl(dataset)
    const [positions, rgb] = await Promise.all([
      buffer(url + '/positions', dataset.pointCount * 12),
      dataset.hasRgb ? buffer(url + '/rgb', dataset.pointCount * 3) : undefined,
    ])
    colorRequest++
    groupRequest++
    viewport.setCloud(new Float32Array(positions), dataset.bounds, rgb && new Uint8Array(rgb))
    cloud = dataset
    activeField = undefined
    color.replaceChildren(new Option('Solid grey', 'grey'))
    if (dataset.hasRgb) color.add(new Option('RGB', 'rgb'))
    instanceField.replaceChildren(new Option('None', ''))
    for (const field of dataset.fields) {
      color.add(new Option(field.name, String(field.id)))
      instanceField.add(new Option(field.name, String(field.id)))
    }
    color.value = dataset.hasRgb ? 'rgb' : 'grey'
    element('scale-control').hidden = true
    element('dataset').textContent = dataset.name
    element('point-count').textContent = counts.format(dataset.pointCount) + ' points'
    element('empty').hidden = true
    clearSelection()
    status()
    requestAnimationFrame(() => performance.measure('cloud-open-to-first-view', { start, end: performance.now() }))
  } catch (error) {
    report(error)
  } finally {
    opening = false
    controls()
  }
}

async function updateColors() {
  const dataset = cloud
  if (!dataset || opening) return
  const serial = ++colorRequest
  const mode = color.value
  if (mode === 'grey') {
    viewport.setColors()
    status()
    return
  }
  status('Loading colors…')
  try {
    const url = cloudUrl(dataset)
    const endpoint = mode === 'rgb'
      ? url + '/rgb'
      : url + '/fields/' + mode + '/colors?categorical=' + (scale.value === 'categories')
    const bytes = await buffer(endpoint, dataset.pointCount * 3)
    if (serial !== colorRequest) return
    viewport.setColors(new Uint8Array(bytes))
    if (!opening) status()
  } catch (error) {
    if (serial === colorRequest && !opening) report(error)
  }
}

async function updateInstanceField() {
  const dataset = cloud
  if (!dataset || opening) return
  const serial = ++groupRequest
  pickRequest++
  activeField = undefined
  const field = instanceField.value
  clearSelection()
  if (!field) {
    status()
    return
  }
  status('Indexing instances…')
  try {
    const bytes = await buffer(cloudUrl(dataset) + '/fields/' + field + '/groups', dataset.pointCount * 4)
    if (serial !== groupRequest) return
    viewport.setGroups(new Uint32Array(bytes))
    activeField = Number(field)
    if (!opening) status()
  } catch (error) {
    if (serial !== groupRequest) return
    instanceField.value = ''
    if (!opening) report(error)
  }
}

async function selectPoint(x: number, y: number) {
  const dataset = cloud
  const field = activeField
  if (!dataset || field === undefined || opening) return
  const serial = ++pickRequest
  const start = performance.now()
  try {
    const point = await viewport.pick(x, y)
    if (serial !== pickRequest) return
    if (point === undefined) {
      clearSelection()
      return
    }
    const response = await request(cloudUrl(dataset) + '/fields/' + field + '/points/' + point)
    const selection: Selection = await response.json()
    if (serial !== pickRequest) return
    if (selection.label === null) {
      clearSelection('This point has no label')
      return
    }
    viewport.highlight(selection.group)
    element('selected-label').textContent = 'Instance ' + selection.label
    element('selected-count').textContent = counts.format(selection.pointCount) + ' points'
    requestAnimationFrame(() => performance.measure('cloud-click-to-highlight', { start, end: performance.now() }))
  } catch (error) {
    if (serial === pickRequest) report(error)
  }
}

