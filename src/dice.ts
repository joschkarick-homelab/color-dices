// Physikalisch simulierte 3D-Würfel (three.js + cannon-es).
//
// Trick für synchronisierte Ergebnisse: Der Wurf wird zuerst unsichtbar
// komplett durchsimuliert. Danach wissen wir, welche Seite oben landet,
// und belegen die Würfelseiten so mit Augenzahlen, dass genau der
// gewünschte (vom Host ausgewürfelte) Wert oben liegt. Anschließend wird
// dieselbe Simulation sichtbar abgespielt — deterministisch, weil sie mit
// identischem Startzustand und identischen Fixed-Steps läuft.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import * as CANNON from 'cannon-es'

export type DieKind = 'white' | 'red' | 'yellow' | 'green' | 'blue'

export interface DieSpec {
  kind: DieKind
  value: number // 1..6, gewünschtes Ergebnis
}

const DIE_COLORS: Record<DieKind, { bg: string; pip: string }> = {
  white: { bg: '#f5f2ea', pip: '#1a1a1a' },
  red: { bg: '#d63a3a', pip: '#ffffff' },
  yellow: { bg: '#e6a817', pip: '#ffffff' },
  green: { bg: '#2e9e4f', pip: '#ffffff' },
  blue: { bg: '#2f6fd6', pip: '#ffffff' },
}

const FIXED_STEP = 1 / 60
const MAX_SIM_STEPS = 60 * 20 // Sicherheitslimit: 20 s Simulationszeit
const DIE_SIZE = 1.25

// BoxGeometry-Materialreihenfolge: +x, -x, +y, -y, +z, -z
const AXES: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Die {
  spec: DieSpec
  mesh: THREE.Mesh
  body: CANNON.Body
  init: {
    position: CANNON.Vec3
    quaternion: CANNON.Quaternion
    velocity: CANNON.Vec3
    angularVelocity: CANNON.Vec3
  }
  faceValues: number[] // Augenzahl je Materialindex (nach dem Remapping)
}

export class DiceTray {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private world: CANNON.World
  private dice: Die[] = []
  private wallBodies: CANNON.Body[] = []
  private textureCache = new Map<string, THREE.Texture>()
  private geometry: RoundedBoxGeometry
  private rafId = 0
  private trayHalf = { x: 5, z: 3 }
  private skipRequested = false
  private audioCtx: AudioContext | null = null
  private lastClack = 0
  muted = false

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    // Fast senkrecht von oben mit leichter Neigung: flachere Perspektive
    // (kleines FOV + mehr Abstand), damit hintere Würfel nicht so weit
    // weg wirken wie bei der alten Schrägansicht.
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
    this.camera.position.set(0, 17, 3.8)
    this.camera.lookAt(0, 0, 0)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1)
    this.scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xffffff, 2.2)
    dir.position.set(-4, 10, 4)
    dir.castShadow = true
    dir.shadow.mapSize.set(1024, 1024)
    dir.shadow.camera.left = -8
    dir.shadow.camera.right = 8
    dir.shadow.camera.top = 8
    dir.shadow.camera.bottom = -8
    this.scene.add(dir)

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.95 })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)

    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -32, 0) })
    this.world.allowSleep = true
    const dieMat = new CANNON.Material('die')
    const floorPhysMat = new CANNON.Material('floor')
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(dieMat, floorPhysMat, { friction: 0.35, restitution: 0.4 }),
    )
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(dieMat, dieMat, { friction: 0.15, restitution: 0.5 }),
    )
    this.dieMaterial = dieMat

    const floorBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: floorPhysMat })
    floorBody.addShape(new CANNON.Plane())
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
    this.world.addBody(floorBody)

    this.geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 4, DIE_SIZE * 0.13)

    this.resize()
    window.addEventListener('resize', this.resize)
    this.renderFrame()
  }

  private dieMaterial: CANNON.Material

  private resize = (): void => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.fitTrayToView()
    this.renderFrame()
  }

  /** Unsichtbare Wände so setzen, dass die Würfel im sichtbaren Bereich bleiben. */
  private fitTrayToView(): void {
    this.camera.updateMatrixWorld() // sonst rechnet der Raycaster mit einer leeren Matrix
    const ray = new THREE.Raycaster()
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const corner = (x: number, y: number): THREE.Vector3 => {
      ray.setFromCamera(new THREE.Vector2(x, y), this.camera)
      const p = new THREE.Vector3()
      ray.ray.intersectPlane(plane, p)
      return p
    }
    const bl = corner(-1, -1)
    const br = corner(1, -1)
    const tl = corner(-1, 1)
    const tr = corner(1, 1)
    const margin = 1.0
    const xMax = Math.min(br.x, tr.x) - margin
    const zNear = Math.min(bl.z, br.z) - margin // untere Kante (großes z)
    const zFar = Math.max(tl.z, tr.z) + margin // obere Kante (kleines z)
    this.trayHalf = {
      x: Math.max(2.5, xMax),
      z: Math.max(1.8, (zNear - zFar) / 2),
    }
    const zCenter = (zNear + zFar) / 2

    for (const b of this.wallBodies) this.world.removeBody(b)
    this.wallBodies = []
    const wall = (px: number, pz: number, sx: number, sz: number): void => {
      const b = new CANNON.Body({ type: CANNON.Body.STATIC })
      b.addShape(new CANNON.Box(new CANNON.Vec3(sx, 6, sz)))
      b.position.set(px, 6, pz)
      this.world.addBody(b)
      this.wallBodies.push(b)
    }
    const { x, z } = this.trayHalf
    wall(-x - 0.5, zCenter, 0.5, z + 2)
    wall(x + 0.5, zCenter, 0.5, z + 2)
    wall(0, zCenter - z - 0.5, x + 2, 0.5)
    wall(0, zCenter + z + 0.5, x + 2, 0.5)
    // Decke gegen Herausfliegen
    const ceil = new CANNON.Body({ type: CANNON.Body.STATIC })
    ceil.addShape(new CANNON.Plane())
    ceil.quaternion.setFromEuler(Math.PI / 2, 0, 0)
    ceil.position.set(0, 7, 0)
    this.world.addBody(ceil)
    this.wallBodies.push(ceil)
    this.trayCenterZ = zCenter
  }

  private trayCenterZ = 0

  private faceTexture(kind: DieKind, value: number): THREE.Texture {
    const key = `${kind}-${value}`
    const cached = this.textureCache.get(key)
    if (cached) return cached

    const size = 192
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const { bg, pip } = DIE_COLORS[kind]
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, size, size)

    const r = size * 0.09
    const c = size / 2
    const o = size * 0.26
    const spots: Record<number, [number, number][]> = {
      1: [[c, c]],
      2: [[c - o, c - o], [c + o, c + o]],
      3: [[c - o, c - o], [c, c], [c + o, c + o]],
      4: [[c - o, c - o], [c + o, c - o], [c - o, c + o], [c + o, c + o]],
      5: [[c - o, c - o], [c + o, c - o], [c, c], [c - o, c + o], [c + o, c + o]],
      6: [[c - o, c - o], [c + o, c - o], [c - o, c], [c + o, c], [c - o, c + o], [c + o, c + o]],
    }
    ctx.fillStyle = pip
    for (const [x, y] of spots[value]) {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      // leichte Vertiefung andeuten
      ctx.save()
      ctx.globalAlpha = 0.25
      ctx.strokeStyle = kind === 'white' ? '#000' : '#00000066'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }

    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    this.textureCache.set(key, tex)
    return tex
  }

  private makeMaterials(kind: DieKind, faceValues: number[]): THREE.Material[] {
    return faceValues.map(
      (v) =>
        new THREE.MeshStandardMaterial({
          map: this.faceTexture(kind, v),
          roughness: 0.35,
          metalness: 0.05,
        }),
    )
  }

  /** Standard-Belegung (1 oben) — wird nach der Vorsimulation umbelegt. */
  private static defaultFaces(): number[] {
    return [3, 4, 1, 6, 2, 5] // +x,-x,+y,-y,+z,-z — Gegenseiten ergeben 7
  }

  private clearDice(): void {
    for (const die of this.dice) {
      this.scene.remove(die.mesh)
      this.world.removeBody(die.body)
      const mats = die.mesh.material as THREE.Material[]
      mats.forEach((m) => m.dispose())
    }
    this.dice = []
  }

  private spawnDice(specs: DieSpec[], rng: () => number): void {
    this.clearDice()
    const n = specs.length
    for (let i = 0; i < n; i++) {
      const spec = specs[i]
      const faceValues = DiceTray.defaultFaces()
      const mesh = new THREE.Mesh(this.geometry, this.makeMaterials(spec.kind, faceValues))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)

      const body = new CANNON.Body({
        mass: 1,
        material: this.dieMaterial,
        shape: new CANNON.Box(new CANNON.Vec3(DIE_SIZE / 2, DIE_SIZE / 2, DIE_SIZE / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.55,
        sleepTimeLimit: 0.3,
      })

      // Start: gestreut über der rechten Seite, Wurf Richtung Traymitte
      const spreadZ = this.trayHalf.z * 1.2
      const px = this.trayHalf.x * (0.55 + rng() * 0.35)
      const pz = this.trayCenterZ + (i / Math.max(1, n - 1) - 0.5) * spreadZ + (rng() - 0.5) * 0.6
      const py = 2.6 + rng() * 2.2
      body.position.set(px, py, pz)

      const q = new CANNON.Quaternion()
      q.setFromEuler(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2)
      body.quaternion.copy(q)

      body.velocity.set(
        -(9 + rng() * 6),
        -2 - rng() * 2,
        (this.trayCenterZ - pz) * (1.2 + rng() * 0.8),
      )
      body.angularVelocity.set(
        (rng() - 0.5) * 30,
        (rng() - 0.5) * 30,
        (rng() - 0.5) * 30,
      )

      body.addEventListener('collide', this.onCollide)
      this.world.addBody(body)

      this.dice.push({
        spec,
        mesh,
        body,
        faceValues,
        init: {
          position: body.position.clone(),
          quaternion: body.quaternion.clone(),
          velocity: body.velocity.clone(),
          angularVelocity: body.angularVelocity.clone(),
        },
      })
    }
  }

  private resetDiceToInit(): void {
    for (const die of this.dice) {
      die.body.position.copy(die.init.position)
      die.body.quaternion.copy(die.init.quaternion)
      die.body.velocity.copy(die.init.velocity)
      die.body.angularVelocity.copy(die.init.angularVelocity)
      die.body.force.set(0, 0, 0)
      die.body.torque.set(0, 0, 0)
      die.body.wakeUp()
    }
  }

  private allSleeping(): boolean {
    return this.dice.every((d) => d.body.sleepState === CANNON.Body.SLEEPING)
  }

  /** Seite, die (in Weltkoordinaten) nach oben zeigt, samt Neigung (dot=1 → flach). */
  private upFace(die: Die): { index: number; dot: number } {
    const q = new THREE.Quaternion(
      die.body.quaternion.x,
      die.body.quaternion.y,
      die.body.quaternion.z,
      die.body.quaternion.w,
    )
    let best = 0
    let bestDot = -Infinity
    for (let i = 0; i < 6; i++) {
      const dir = AXES[i].clone().applyQuaternion(q)
      if (dir.y > bestDot) {
        bestDot = dir.y
        best = i
      }
    }
    return { index: best, dot: bestDot }
  }

  private upFaceIndex(die: Die): number {
    return this.upFace(die).index
  }

  /** Liegen alle Würfel flach (nicht schief angelehnt)? */
  private allFlat(): boolean {
    return this.dice.every((d) => this.upFace(d).dot > 0.97)
  }

  /** Seiten so belegen, dass `value` auf dem Materialindex `upIdx` liegt. */
  private remapFaces(die: Die, upIdx: number, value: number): void {
    const pairs = [
      [1, 6],
      [2, 5],
      [3, 4],
    ].filter(([a]) => a !== Math.min(value, 7 - value))
    const faces = new Array<number>(6)
    faces[upIdx] = value
    faces[upIdx ^ 1] = 7 - value
    const restAxes = [0, 2, 4].filter((a) => a !== (upIdx & ~1))
    restAxes.forEach((axis, i) => {
      faces[axis] = pairs[i][0]
      faces[axis + 1] = pairs[i][1]
    })
    die.faceValues = faces
    const old = die.mesh.material as THREE.Material[]
    old.forEach((m) => m.dispose())
    die.mesh.material = this.makeMaterials(die.spec.kind, faces)
  }

  private syncMeshes(): void {
    for (const die of this.dice) {
      die.mesh.position.set(die.body.position.x, die.body.position.y, die.body.position.z)
      die.mesh.quaternion.set(
        die.body.quaternion.x,
        die.body.quaternion.y,
        die.body.quaternion.z,
        die.body.quaternion.w,
      )
    }
  }

  private renderFrame(): void {
    this.renderer.render(this.scene, this.camera)
  }

  // -------------------------------------------------------------------------
  // Sound

  private silentSim = false

  private onCollide = (e: { contact: CANNON.ContactEquation }): void => {
    if (this.silentSim || this.muted) return
    const impact = Math.abs(e.contact.getImpactVelocityAlongNormal())
    if (impact < 2.5) return
    const now = performance.now()
    if (now - this.lastClack < 45) return
    this.lastClack = now
    this.clack(Math.min(1, impact / 14))
  }

  private clack(volume: number): void {
    try {
      this.audioCtx ??= new AudioContext()
      const ctx = this.audioCtx
      if (ctx.state === 'suspended') void ctx.resume()
      const len = 0.04
      const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 2400 + Math.random() * 1200
      const gain = ctx.createGain()
      gain.gain.value = 0.35 * volume
      src.connect(filter).connect(gain).connect(ctx.destination)
      src.start()
    } catch {
      // Audio ist optional — Fehler ignorieren
    }
  }

  // -------------------------------------------------------------------------
  // Öffentliche API

  /** Während der Animation aufrufen, um den Wurf sofort zu Ende zu spulen. */
  skip(): void {
    this.skipRequested = true
  }

  /**
   * Wirft die Würfel. Die sichtbare Physik ist echt — das Ergebnis entspricht
   * trotzdem exakt `specs[i].value` (siehe Kommentar am Dateianfang).
   */
  async roll(specs: DieSpec[]): Promise<void> {
    cancelAnimationFrame(this.rafId)
    this.skipRequested = false

    // 1) Unsichtbare Vorsimulation. Landet ein Würfel schief (an einem anderen
    //    angelehnt), wird der komplette Wurf neu ausgeführt — wie am echten Tisch.
    let presimSteps = 0
    for (let attempt = 0; attempt < 5; attempt++) {
      const rng = mulberry32((Math.random() * 2 ** 31) | 0)
      this.spawnDice(specs, rng)
      this.silentSim = true
      presimSteps = 0
      while (!this.allSleeping() && presimSteps < MAX_SIM_STEPS) {
        this.world.step(FIXED_STEP)
        presimSteps++
      }
      this.silentSim = false
      if (this.allFlat()) break
    }

    // 2) Seiten passend zum gewünschten Ergebnis belegen
    for (const die of this.dice) {
      this.remapFaces(die, this.upFaceIndex(die), die.spec.value)
    }

    // 3) Zurücksetzen und sichtbar abspielen
    this.resetDiceToInit()
    await new Promise<void>((resolve) => {
      let last = performance.now()
      let acc = 0
      let steps = 0
      const frame = (now: number): void => {
        acc += Math.min(0.1, (now - last) / 1000)
        last = now
        while (acc >= FIXED_STEP && steps < presimSteps) {
          this.world.step(FIXED_STEP)
          acc -= FIXED_STEP
          steps++
        }
        if (this.skipRequested) {
          this.silentSim = true
          while (steps < presimSteps && !this.allSleeping()) {
            this.world.step(FIXED_STEP)
            steps++
          }
          this.silentSim = false
        }
        this.syncMeshes()
        this.renderFrame()
        if ((this.allSleeping() && steps > 10) || steps >= presimSteps) {
          resolve()
        } else {
          this.rafId = requestAnimationFrame(frame)
        }
      }
      this.rafId = requestAnimationFrame(frame)
    })

    // 4) Sicherheitsnetz: falls die Wiedergabe minimal von der Vorsimulation
    //    abweicht, den Würfel sanft auf die korrekte Seite drehen.
    await this.correctOrientations()
    this.renderFrame()
  }

  private async correctOrientations(): Promise<void> {
    const fixes: { die: Die; from: THREE.Quaternion; to: THREE.Quaternion }[] = []
    for (const die of this.dice) {
      const upIdx = this.upFaceIndex(die)
      if (die.faceValues[upIdx] === die.spec.value) continue
      const targetIdx = die.faceValues.indexOf(die.spec.value)
      const q = die.mesh.quaternion.clone()
      const currentDir = AXES[targetIdx].clone().applyQuaternion(q)
      const fix = new THREE.Quaternion().setFromUnitVectors(
        currentDir,
        new THREE.Vector3(0, 1, 0),
      )
      fixes.push({ die, from: q, to: fix.multiply(q) })
    }
    if (!fixes.length) return
    const duration = 280
    const start = performance.now()
    await new Promise<void>((resolve) => {
      const frame = (now: number): void => {
        const t = Math.min(1, (now - start) / duration)
        for (const f of fixes) {
          f.die.mesh.quaternion.slerpQuaternions(f.from, f.to, t)
        }
        this.renderFrame()
        if (t >= 1) resolve()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.resize)
    this.clearDice()
    this.textureCache.forEach((t) => t.dispose())
    this.geometry.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
