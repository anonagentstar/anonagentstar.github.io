// A pre-baked reconstruction viewer: our mesh + the GT MANO hands in 3D, the
// observed frame and our reprojected silhouette in a corner panel, and a
// timeline to scrub. Everything it reads was written by metrics/site_bake.py
// (agentic_artic) via the per-dataset bake scripts -- no server involved.
//
// Mobile browsers allow only a handful of WebGL contexts, so all viewers on a
// page share ONE renderer (`Stage`): the active slide borrows its canvas, the
// others show a poster frame until they are activated.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TrackballControls } from '../vendor/TrackballControls.js';

const LEFT_HAND = 0x6296ed;
const RIGHT_HAND = 0xe77969;
// Same flat tint the interactive viewer paints (BGR 215,200,72 == #48c8d7).
const SILHOUETTE_RGB = [72, 200, 215];
const SILHOUETTE_ALPHA = 0.52;
// Pre-rendered part layers (in-the-wild bakes) are drawn over the frame at
// this opacity; joint axes use art_viewer's yellow.
const RENDER_ALPHA = 0.82;
const JOINT_COLOR = 0xe0c341;
// Default framing (ARCTIC's z-up world); a bake can override via meta.view.
// The direction sits on the capture camera's side of the object (ARCTIC's
// camera is at +y, high above it), so the orbit view opens facing the same
// way the frame does, just farther back.
const DEFAULT_VIEW = { up: [0, 0, 1], direction: [-1.2, 1.45, 0.95] };

const TYPES = {
  f4: Float32Array, i4: Int32Array, u1: Uint8Array,
  i2: Int16Array, u2: Uint16Array,
};

function parseGeometry(buffer) {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(
    new Uint8Array(buffer, 4, headerLength)));
  const base = 4 + headerLength;
  const geometry = {};
  for (const item of header.buffers) {
    const Type = TYPES[item.dtype];
    geometry[item.name] = {
      data: new Type(buffer.slice(
        base + item.offset, base + item.offset + item.length)),
      shape: item.shape,
    };
  }
  return geometry;
}

// int16 codes -> metres, per the bake's per-axis (min, scale).
function dequantize(buffer, params) {
  const out = new Float32Array(buffer.data.length);
  const { min, scale } = params;
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (buffer.data[i] + 32768) * scale[0] + min[0];
    out[i + 1] = (buffer.data[i + 1] + 32768) * scale[1] + min[1];
    out[i + 2] = (buffer.data[i + 2] + 32768) * scale[2] + min[2];
  }
  return { data: out, shape: buffer.shape };
}

function frameSlice(buffer, frame) {
  const count = buffer.shape[1] * 3;
  return buffer.data.subarray(frame * count, (frame + 1) * count);
}

function material(color, vertexColors) {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : color,
    vertexColors,
    roughness: 0.72,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });
}

// ── shared renderer ──
class Stage {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'viewer-canvas';
    this.active = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    const animate = () => {
      requestAnimationFrame(animate);
      if (!this.active || !this.active.scene) return;
      // OrbitControls.update() re-levels the camera to `up`; while following
      // the capture camera its exact pose (roll included) must stand.
      if (!this.active.follow) this.active.controls?.update();
      this.renderer.render(this.active.scene, this.active.camera);
    };
    animate();
  }

  attach(viewer) {
    if (this.active === viewer) return;
    if (this.active) this.active.onDetach();
    this.active = viewer;
    viewer.viewport3d.appendChild(this.renderer.domElement);
    this.resizeObserver.disconnect();
    this.resizeObserver.observe(viewer.viewport3d);
    this.resize();
  }

  resize() {
    const viewer = this.active;
    if (!viewer) return;
    const width = viewer.viewport3d.clientWidth;
    const height = viewer.viewport3d.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    viewer.camera.aspect = width / height;
    viewer.updateProjection();
    viewer.controls?.handleResize?.();   // TrackballControls maps drags to the canvas size
  }
}

let stage = null;
export function sharedStage() {
  if (!stage) stage = new Stage();
  return stage;
}

// ── one example ──
export class ArcticViewer {
  /**
   * @param {HTMLElement} root  the .viewer element (template in index.html)
   * @param {string} baseUrl    directory holding meta.json / geometry.bin
   */
  constructor(root, baseUrl) {
    this.root = root;
    this.baseUrl = baseUrl.replace(/\/?$/, '/');
    this.viewport = root.querySelector('.viewer-viewport');
    // Where the shared canvas goes (the whole viewport, or the left column of
    // a split card).
    this.viewport3d = root.querySelector('.viewer-3d') || this.viewport;
    // A trackpad swipe reaches OrbitControls as a wheel event, which it would
    // take as a zoom: on a follow card that released the capture camera and
    // the view jumped to the orbit projection. A sideways swipe is the
    // visitor moving the carousel, and while following, any wheel is the page
    // scrolling; neither reaches the canvas (OrbitControls only preventDefaults
    // wheels it handles, so the track / page scroll natively).
    this.viewport3d.addEventListener('wheel', event => {
      if (this.follow || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.stopPropagation();
      }
    }, { capture: true, passive: true });
    this.$ = selector => root.querySelector(selector);
    this.joints = [];                // {arrow, sphere} per joint (articulated)
    this.showJoints = true;
    this.meta = null;
    this.geometry = null;
    this.frame = 0;
    this.playing = false;
    this.timer = null;
    this.loadPromise = null;
    this.panel = { frame: [], tint: [] };
    this.layers = {};
    this.controls = null;
    this.viewUp = null;              // the world's up (meta.view), set by buildScene
    this.follow = false;             // tracking the capture camera?
    this.followIntrinsics = null;    // K of the frame being followed

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101214);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.005, 100);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, -2, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc7ff, 0.65);
    fill.position.set(-2, 1, 1);
    this.scene.add(fill);
    this.sceneRoot = new THREE.Group();
    this.scene.add(this.sceneRoot);

    this.wireControls();
  }

  // Fetch + parse meta and geometry. Safe to call early (prefetch): it never
  // touches the renderer. Frames stream in afterwards.
  load() {
    if (!this.loadPromise) this.loadPromise = this._load();
    return this.loadPromise;
  }

  async _load() {
    this.status('loading geometry');
    const [metaResponse, geometryResponse] = await Promise.all([
      fetch(this.baseUrl + 'meta.json'),
      fetch(this.baseUrl + 'geometry.bin'),
    ]);
    if (!metaResponse.ok || !geometryResponse.ok) {
      throw new Error(`viewer assets missing under ${this.baseUrl}`);
    }
    this.meta = await metaResponse.json();
    const raw = parseGeometry(await geometryResponse.arrayBuffer());
    this.geometry = {};
    for (const [name, buffer] of Object.entries(raw)) {
      const params = this.meta.quantization[name];
      this.geometry[name] = params ? dequantize(buffer, params) : buffer;
    }
    this.buildScene();
    // The panel canvases take the baked frames' aspect (square HOT3D crops,
    // 7:5 ARCTIC frames) instead of a fixed CSS ratio, so nothing is squashed.
    const [imageWidth, imageHeight] = this.meta.image_size;
    for (const canvas of this.root.querySelectorAll('.viewer-panel canvas')) {
      canvas.style.aspectRatio = `${imageWidth} / ${imageHeight}`;
    }
    if (this.meta.panel === 'render') {
      const parts = this.meta.parts?.length;
      this.$('.viewer-overlay').nextElementSibling.textContent =
        `Ours, re-rendered into the frame${parts ? ` · ${parts} parts, one colour each` : ''}`;
    }
    this.$('.viewer-slider').max = this.meta.n_frames - 1;
    this.markKeyframes();
    this.setFrame(0);
    this.status('');
    this.preparePanelImages();
  }

  // A smooth bake (meta.keyframes) interpolates the 3D between the run's
  // keyframes and has a picture only at those: tick them under the slider so
  // the scrubber shows where the images are.
  markKeyframes() {
    const slider = this.$('.viewer-slider');
    slider.parentElement.querySelector('datalist')?.remove();
    slider.removeAttribute('list');
    const keyframes = this.meta.keyframes;
    if (!keyframes || keyframes.length >= this.meta.n_frames) return;
    const list = document.createElement('datalist');
    list.id = `keyframes-${Math.random().toString(36).slice(2, 8)}`;
    for (const index of keyframes) {
      const option = document.createElement('option');
      option.value = index;
      list.appendChild(option);
    }
    slider.after(list);
    slider.setAttribute('list', list.id);
  }

  // The frame whose picture the panel shows: the frame itself, or (a smooth
  // bake) the last keyframe at or before it.
  panelFrame(frame) {
    const keyframes = this.meta.keyframes;
    if (!keyframes) return frame;
    let shown = keyframes[0];
    for (const index of keyframes) {
      if (index > frame) break;
      shown = index;
    }
    return shown;
  }

  // The floor grid: perpendicular to `up`, just under the scene's lowest point.
  addGrid(center, bounds, radius, up) {
    const grid = new THREE.GridHelper(radius * 4, 24, 0x3d444c, 0x22272c);
    grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const lowest = Math.min(...[
      [bounds.min[0], bounds.min[1], bounds.min[2]],
      [bounds.max[0], bounds.min[1], bounds.min[2]],
      [bounds.min[0], bounds.max[1], bounds.min[2]],
      [bounds.max[0], bounds.max[1], bounds.min[2]],
      [bounds.min[0], bounds.min[1], bounds.max[2]],
      [bounds.max[0], bounds.min[1], bounds.max[2]],
      [bounds.min[0], bounds.max[1], bounds.max[2]],
      [bounds.max[0], bounds.max[1], bounds.max[2]],
    ].map(corner => new THREE.Vector3().fromArray(corner).dot(up)));
    grid.position.copy(center).addScaledVector(
      up, lowest - center.dot(up) - radius * 0.04);
    this.sceneRoot.add(grid);
  }

  buildScene() {
    const focus = this.meta.focus;
    const bounds = this.meta.bounds;
    const radius = Math.max(bounds.radius, 0.1);
    const view = { ...DEFAULT_VIEW, ...(this.meta.view || {}) };
    const up = new THREE.Vector3().fromArray(view.up).normalize();
    const direction = new THREE.Vector3().fromArray(view.direction).normalize();
    const center = new THREE.Vector3().fromArray(focus.center);
    // An example may bring its own 3D backdrop (meta.view.background, a CSS
    // colour): near-white for dark objects that vanish against the page.
    if (view.background) {
      this.scene.background = new THREE.Color(view.background);
      this.viewport3d.style.background = view.background;
    }
    // A floor grid perpendicular to "up", just under the lowest point. Cards
    // marked data-grid="none" (in the wild: the world is the phone's camera
    // frame, so a floor there means nothing) draw none.
    if (this.root.dataset.grid !== 'none') this.addGrid(center, bounds, radius, up);

    const colors = this.meta.has_prediction_colors
      ? this.geometry.prediction_colors : null;
    if (this.meta.articulated) {
      this.buildParts(colors);
      this.buildJoints(Math.max(this.meta.object_radius || focus.radius, 0.05));
    } else {
      this.layers.prediction = this.createLayer(
        'prediction_verts', 'prediction_faces', 0x48c8d7, colors, null,
        'prediction_transforms');
    }
    this.layers.left = this.createLayer(
      'left_verts', 'left_faces', LEFT_HAND, null, 'left_valid');
    this.layers.right = this.createLayer(
      'right_verts', 'right_faces', RIGHT_HAND, null, 'right_valid');

    const focusRadius = Math.max(focus.radius, 0.05);
    this.focusCenter = center;
    this.viewUp = up;
    this.resetView = () => {
      // Release the capture camera first: that hands its field of view to the
      // orbit camera, which the defaults below then replace.
      this.setFollow(false);
      // Closer than the interactive viewer (2.8x): the page has no side panel
      // competing for space, and the corner panel leaves the centre clear.
      this.camera.position.copy(center).addScaledVector(
        direction, focusRadius * 2.3);
      this.camera.up.copy(up);
      this.camera.fov = 42;
      this.camera.near = focusRadius * 0.005;
      this.camera.far = Math.max(radius, focusRadius) * 40;
      this.camera.updateProjectionMatrix();
      if (this.controls) {
        this.controls.target.copy(center);
        this.controls.update();
      } else {
        this.camera.lookAt(center);
      }
      // Cards marked data-camera="follow" (in the wild) open as the capture
      // camera instead: the 3D view then matches the re-rendered frame beside
      // it. Dragging still orbits away; reset comes back here.
      if (this.root.dataset.camera === 'follow') {
        this.follow = true;
        this.$('.viewer-camera').classList.add('active');
        this.applyCameraFrame();
      }
    };
    this.resetView();
  }

  // An articulated prediction: the rest mesh is one vertex stream, each part a
  // vertex/face range of it (meta.parts), moved by its own 4x4 per frame from
  // the (F, P*16) `part_transforms` stream.
  buildParts(colors) {
    const vertices = this.geometry.prediction_verts;
    const faces = this.geometry.prediction_faces.data;
    const transforms = this.geometry.part_transforms;
    const stride = this.meta.parts.length;
    this.meta.parts.forEach((part, index) => {
      const [v0, v1] = part.vertex_range;
      const [f0, f1] = part.face_range;
      if (f1 <= f0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array(vertices.data.subarray(v0 * 3, v1 * 3)), 3));
      const local = new Uint32Array(faces.subarray(f0 * 3, f1 * 3));
      for (let i = 0; i < local.length; i++) local[i] -= v0;
      geometry.setIndex(new THREE.BufferAttribute(local, 1));
      const useColors = !!(colors && colors.shape[0] === vertices.shape[1]);
      if (useColors) {
        geometry.setAttribute('color', new THREE.BufferAttribute(
          colors.data.subarray(v0 * 3, v1 * 3), 3, true));
      }
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material(0x9a9ca1, useColors));
      mesh.matrixAutoUpdate = false;
      this.sceneRoot.add(mesh);
      this.layers[`part:${part.name}`] = {
        mesh, transforms: transforms.data, stride, offset: index,
      };
    });
  }

  // Joint axes as in art_viewer: a yellow arrow along the axis through the
  // pivot (here centred on it) and a pivot sphere, sized to the object.
  buildJoints(radius) {
    const joints = this.meta.joints || [];
    this.jointGroup = new THREE.Group();
    this.sceneRoot.add(this.jointGroup);
    // radius is half the object; span it. A long chain (the bending spoon has
    // ten joints along its handle) gets shorter glyphs so they don't thicket.
    this.jointLength = radius * 1.3 * Math.min(1, 4 / Math.max(joints.length, 1));
    for (const joint of joints) {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(), this.jointLength,
        JOINT_COLOR, this.jointLength * 0.08, this.jointLength * 0.04);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(this.jointLength * 0.025, 16, 12),
        new THREE.MeshBasicMaterial({ color: JOINT_COLOR }));
      this.jointGroup.add(arrow, sphere);
      this.joints.push({ joint, arrow, sphere });
    }
    if (joints.length) {
      this.root.classList.add('has-joints');
      this.setJointsVisible(this.showJoints);
    }
  }

  setJointsVisible(on) {
    this.showJoints = on;
    if (this.jointGroup) this.jointGroup.visible = on;
    this.$('.viewer-joints').classList.toggle('active', on);
  }

  updateJoints() {
    if (!this.joints.length) return;
    const J = this.joints.length;
    const origins = this.geometry.joint_origins.data;
    const axes = this.geometry.joint_axes.data;
    const states = this.geometry.joint_states.data;
    const readout = [];
    this.joints.forEach(({ joint, arrow, sphere }, j) => {
      const at = (this.frame * J + j) * 3;
      const origin = new THREE.Vector3(
        origins[at], origins[at + 1], origins[at + 2]);
      const direction = new THREE.Vector3(
        axes[at], axes[at + 1], axes[at + 2]).normalize();
      arrow.position.copy(origin).addScaledVector(direction, -this.jointLength / 2);
      arrow.setDirection(direction);
      sphere.position.copy(origin);
      const value = states[this.frame * J + j];
      readout.push(joint.type === 'revolute'
        ? `${joint.name} ${Math.round(value)}°`
        : `${joint.name} ${value.toFixed(2)}`);
    });
    this.$('.viewer-joints-readout').textContent = readout.join(' · ');
  }

  // The camera's projection: three's own symmetric one normally, or, while
  // following the capture camera, one built from the frame's intrinsics so an
  // off-centre principal point (HOT3D crops) projects exactly like the panel.
  // The whole image fits inside the viewport (as the panel's object-fit:
  // contain does), centred, with square pixels: a landscape frame in a tall
  // split column fills the width, a portrait one the height.
  updateProjection() {
    const K = this.followIntrinsics;
    if (!K) {
      this.camera.updateProjectionMatrix();
      return;
    }
    const [imageWidth, imageHeight] = this.meta.source_image_size;
    const [fx, , cx, , fy, cy] = K;
    // The viewport, in image pixels.
    const tall = this.camera.aspect < imageWidth / imageHeight;
    const width = tall ? imageWidth : imageHeight * this.camera.aspect;
    const height = tall ? imageWidth / this.camera.aspect : imageHeight;
    const shiftedCx = cx + (width - imageWidth) / 2;
    const shiftedCy = cy + (height - imageHeight) / 2;
    const near = this.camera.near;
    const far = this.camera.far;
    this.camera.projectionMatrix.set(
      2 * fx / width, 0, 1 - 2 * shiftedCx / width, 0,
      0, 2 * fy / height, 2 * shiftedCy / height - 1, 0,
      0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
      0, 0, -1, 0);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix)
      .invert();
  }

  setFollow(on) {
    this.follow = on;
    this.$('.viewer-camera').classList.toggle('active', on);
    if (!on) {
      // Hand the orbit camera the field of view the capture camera had in
      // this viewport, so the picture holds still at the moment a drag takes
      // over (reset puts the default back).
      if (this.followIntrinsics) {
        const [imageWidth, imageHeight] = this.meta.source_image_size;
        const fy = this.followIntrinsics[4];
        const tall = this.camera.aspect < imageWidth / imageHeight;
        const height = tall ? imageWidth / this.camera.aspect : imageHeight;
        this.camera.fov = THREE.MathUtils.radToDeg(
          2 * Math.atan(height / (2 * fy)));
        // OrbitControls re-levels the camera to its `up`, so a rolled capture
        // camera (a phone held askew) would snap upright as the drag begins.
        // Orbit about the camera's own up then; a level frame keeps the world's.
        // Trackball cards have no fixed up at all and just continue from the
        // camera's.
        const worldUp = this.viewUp || this.camera.up;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        if (this.root.dataset.controls === 'trackball'
            || Math.abs(right.dot(worldUp)) > Math.sin(THREE.MathUtils.degToRad(3))) {
          this.camera.up.copy(
            new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
        } else {
          this.camera.up.copy(worldUp);
        }
      }
      this.followIntrinsics = null;
      this.updateProjection();
    }
  }

  // `validKey` names an optional per-frame 0/1 stream (a GT hand missing from
  // some frames); a stream with no faces at all is a placeholder and is
  // skipped. `transformKey` names an optional (F,16) row-major stream for a
  // RIGID mesh baked once: the frame then moves the mesh's matrix instead of
  // rewriting its vertices.
  createLayer(vertexKey, faceKey, color, colors, validKey, transformKey) {
    const vertices = this.geometry[vertexKey];
    const faces = this.geometry[faceKey];
    if (!vertices || !faces || faces.data.length === 0) return null;
    const valid = validKey && this.geometry[validKey]
      ? this.geometry[validKey].data : null;
    const transforms = transformKey && this.geometry[transformKey]
      ? this.geometry[transformKey].data : null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(frameSlice(vertices, 0)), 3));
    geometry.setIndex(new THREE.BufferAttribute(
      new Uint32Array(faces.data), 1));
    const useColors = !!(colors && colors.shape[0] === vertices.shape[1]);
    if (useColors) {
      geometry.setAttribute(
        'color', new THREE.BufferAttribute(colors.data, 3, true));
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material(color, useColors));
    if (transforms) mesh.matrixAutoUpdate = false;
    this.sceneRoot.add(mesh);
    return { mesh, vertices, valid, transforms };
  }

  // Look through the capture camera: the reprojection panel and the 3D view
  // then show the same picture. Stays on, tracking a moving camera frame by
  // frame, until the visitor orbits away or resets. Pressing again turns it
  // off.
  cameraView() {
    if (!this.meta) return;
    if (this.follow) {
      this.setFollow(false);
      return;
    }
    this.follow = true;
    this.$('.viewer-camera').classList.add('active');
    this.applyCameraFrame();
  }

  applyCameraFrame() {
    const c2w = this.meta.camera.c2w[this.frame];
    const matrix = new THREE.Matrix4().fromArray(c2w).transpose();
    // OpenCV looks down +z with y down; three looks down -z with y up.
    matrix.multiply(new THREE.Matrix4().makeScale(1, -1, -1));
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    matrix.decompose(position, quaternion, new THREE.Vector3());
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    this.followIntrinsics = this.meta.camera.intrinsics[this.frame];
    this.updateProjection();
    if (this.controls) {
      // Keep the orbit target ahead of the lens so the drag that ends the
      // follow pivots around the object, not around the camera itself. The
      // controls are not updated while following (see Stage), so the pose set
      // above stands until then.
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
      const distance = Math.max(
        this.focusCenter.clone().sub(position).dot(forward), 0.1);
      this.controls.target.copy(position).addScaledVector(forward, distance);
    }
  }

  setFrame(frame) {
    const n = this.meta.n_frames;
    this.frame = ((frame % n) + n) % n;
    for (const layer of Object.values(this.layers)) {
      if (!layer) continue;
      layer.mesh.visible = !layer.valid || layer.valid[this.frame] === 1;
      if (!layer.mesh.visible) continue;
      if (layer.transforms) {
        // Row-major in the file; three's fromArray reads column-major. Part
        // layers index an (F, P, 16) stream, rigid ones an (F, 16) one.
        const at = (this.frame * (layer.stride || 1) + (layer.offset || 0)) * 16;
        layer.mesh.matrix.fromArray(layer.transforms.subarray(at, at + 16))
          .transpose();
        layer.mesh.matrixWorldNeedsUpdate = true;
        continue;
      }
      const positions = layer.mesh.geometry.getAttribute('position');
      positions.array.set(frameSlice(layer.vertices, this.frame));
      positions.needsUpdate = true;
      layer.mesh.geometry.computeVertexNormals();
    }
    this.$('.viewer-slider').value = this.frame;
    // Figure spaces pad the counter to the total's width, so it never jitters
    // or wraps as the digits change (291-frame smooth bakes).
    this.$('.viewer-count').textContent =
      `${String(this.frame + 1).padStart(String(n).length, ' ')} / ${n}`;
    this.updateJoints();
    if (this.follow) this.applyCameraFrame();
    this.showPanelImages();
  }

  // ── 2D panel ──
  // Every frame is decoded ONCE into ImageBitmaps (photo + pre-tinted
  // silhouette layer), so a playback tick is two drawImage calls per canvas.
  showPanelImages() {
    const shown = this.panelFrame(this.frame);
    // Between keyframes the panel holds the last picture: the 3D view moves
    // on, the photo does not.
    this.$('.viewer-panel').classList.toggle('is-between', shown !== this.frame);
    const photo = this.panel.frame[shown];
    const tint = this.panel.tint[shown];
    const observed = this.$('.viewer-observed');
    const overlay = this.$('.viewer-overlay');
    if (!photo) return;
    for (const canvas of [observed, overlay]) {
      if (canvas.width !== photo.width || canvas.height !== photo.height) {
        canvas.width = photo.width;
        canvas.height = photo.height;
      }
    }
    observed.getContext('2d').drawImage(photo, 0, 0);
    const context = overlay.getContext('2d');
    context.drawImage(photo, 0, 0);
    if (tint) {
      // A silhouette layer carries its own alpha; a pre-rendered part layer is
      // opaque where the mesh is and gets RENDER_ALPHA here.
      context.globalAlpha = this.meta.panel === 'render' ? RENDER_ALPHA : 1;
      context.drawImage(tint, 0, 0);
      context.globalAlpha = 1;
    }
  }

  async preparePanelImages() {
    const total = this.meta.n_frames;
    const [width, height] = this.meta.image_size;
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchContext = scratch.getContext('2d', { willReadFrequently: true });

    // The mask PNG is grey = coverage; turn it into an RGBA layer whose alpha
    // is 0.52 * coverage in the silhouette colour, so drawing it over the photo
    // reproduces the interactive viewer's blend exactly.
    const tintLayer = async maskBitmap => {
      scratchContext.clearRect(0, 0, width, height);
      scratchContext.drawImage(maskBitmap, 0, 0, width, height);
      const image = scratchContext.getImageData(0, 0, width, height);
      const pixels = image.data;
      for (let i = 0; i < pixels.length; i += 4) {
        const coverage = pixels[i];
        pixels[i] = SILHOUETTE_RGB[0];
        pixels[i + 1] = SILHOUETTE_RGB[1];
        pixels[i + 2] = SILHOUETTE_RGB[2];
        pixels[i + 3] = Math.round(coverage * SILHOUETTE_ALPHA);
      }
      scratchContext.putImageData(image, 0, 0);
      maskBitmap.close?.();
      return createImageBitmap(scratch);
    };

    const url = (pattern, index) => this.baseUrl + pattern.replace(
      '{index:03d}', String(index).padStart(3, '0'));
    const fetchBitmap = async href => {
      const response = await fetch(href);
      if (!response.ok) throw new Error(href);
      return createImageBitmap(await response.blob());
    };

    const rendered = this.meta.panel === 'render';
    let done = 0;
    // Only the frames that have a picture (all of them, or the keyframes).
    const queue = this.meta.keyframes
      ? [...this.meta.keyframes]
      : Array.from({ length: total }, (_, f) => f);
    const wanted = queue.length;
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const frame = queue.shift();
        try {
          const [photo, layer] = await Promise.all([
            fetchBitmap(url(this.meta.files.frame, frame)),
            fetchBitmap(url(rendered ? this.meta.files.render
              : this.meta.files.mask, frame)),
          ]);
          this.panel.frame[frame] = photo;
          this.panel.tint[frame] = rendered ? layer : await tintLayer(layer);
          if (frame === this.panelFrame(this.frame)) this.showPanelImages();
        } catch (error) {
          console.warn(error);
        }
        done += 1;
        this.status(done < wanted ? `frames ${Math.round(100 * done / wanted)}%` : '');
      }
    });
    await Promise.all(workers);
  }

  // ── playback ──
  stop() {
    this.playing = false;
    this.root.classList.remove('is-playing');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  play() {
    if (!this.meta) return;
    this.stop();
    this.playing = true;
    this.root.classList.add('is-playing');
    this.timer = setInterval(
      () => this.setFrame(this.frame + 1), 1000 / (this.meta.fps || 5));
  }

  status(text) {
    this.$('.viewer-status').textContent = text;
  }

  // ── activation (the shared renderer) ──
  isLive() {
    return stage !== null && stage.active === this
      && this.root.classList.contains('is-live');
  }

  async activate() {
    this.root.classList.add('is-active');
    try {
      await this.load();
    } catch (error) {
      console.error(error);
      this.status(error.message);
      return;
    }
    const s = sharedStage();
    s.attach(this);
    if (this.root.dataset.controls === 'trackball') {
      // Free rotation, no fixed up axis: in the wild the world is the phone's
      // camera frame, so an orbit pole there is arbitrary and blocks angles.
      this.controls = new TrackballControls(this.camera, s.renderer.domElement);
      this.controls.rotateSpeed = 2.0;
      this.controls.dynamicDampingFactor = 0.15;
    } else {
      this.controls = new OrbitControls(this.camera, s.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
    }
    this.controls.target.copy(this.focusCenter);
    this.controls.update();
    // Orbiting takes over from the capture camera.
    this.controls.addEventListener('start', () => {
      if (this.follow) this.setFollow(false);
    });
    // Detaching (another carousel took the renderer) releases the capture
    // camera; a follow card coming back live starts from its camera view again.
    if (this.root.dataset.camera === 'follow' && !this.follow) this.resetView();
    this.root.classList.add('is-live');
    if (!this.playing) this.play();
  }

  onDetach() {
    this.stop();
    this.controls?.dispose();
    this.controls = null;
    if (this.follow) this.setFollow(false);
    this.root.classList.remove('is-live', 'is-active');
  }

  deactivate() {
    if (stage && stage.active === this) {
      stage.active = null;
      stage.renderer.domElement.remove();
    }
    this.onDetach();
  }

  // ── fullscreen ──
  // The Fullscreen API is missing on iOS Safari for non-video elements, so a
  // fixed-position class stands in for it there.
  toggleFullscreen() {
    const card = this.root;
    if (document.fullscreenElement === card) {
      document.exitFullscreen();
      return;
    }
    if (card.classList.contains('is-fullscreen')) {
      this.setFullscreenState(false);
      return;
    }
    if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => this.setFullscreenState(true));
    } else {
      this.setFullscreenState(true);
    }
  }

  // Both the real and the pseudo path end here, so the carousel gets one
  // consistent signal (`onFullscreenChange`) either way.
  setFullscreenState(on) {
    const was = this.root.classList.contains('is-fullscreen');
    this.root.classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('has-fullscreen-viewer', on);
    if (was !== on) this.onFullscreenChange?.(on);
  }

  wireControls() {
    this.$('.viewer-play').addEventListener('click', () => {
      this.playing ? this.stop() : this.play();
    });
    this.$('.viewer-slider').addEventListener('input', event => {
      this.stop();
      if (this.meta) this.setFrame(Number(event.target.value));
    });
    this.$('.viewer-reset').addEventListener('click', () => this.resetView?.());
    this.$('.viewer-camera').addEventListener('click', () => this.cameraView());
    this.$('.viewer-joints').addEventListener(
      'click', () => this.setJointsVisible(!this.showJoints));
    this.$('.viewer-fullscreen').addEventListener(
      'click', () => this.toggleFullscreen());
    this.root.addEventListener('keydown', event => {
      if (!this.meta) return;
      if (event.key === 'ArrowRight') {
        this.stop(); this.setFrame(this.frame + 1); event.preventDefault();
      } else if (event.key === 'ArrowLeft') {
        this.stop(); this.setFrame(this.frame - 1); event.preventDefault();
      } else if (event.key === ' ') {
        event.preventDefault();
        this.playing ? this.stop() : this.play();
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement === this.root;
      if (on || this.root.classList.contains('is-fullscreen')) {
        this.setFullscreenState(on);
      }
    });
  }
}
