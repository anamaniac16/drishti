/*
 * globe.js
 * The 3D scene: Earth with a real day/night line, clouds, atmosphere,
 * low-poly satellites, ground stations and request pins.
 * Coordinates are Earth-fixed, so the Earth stays still and the Sun moves.
 */
(function (root) {
  'use strict';

  const T = root.THREE;
  const D = root.Drishti;
  const ALT_SCALE = 3;  // satellites drawn higher than real so they read on screen

  // lat/lon (deg) -> scene position on a sphere of radius r
  function ll(lat, lon, r) {
    const la = lat * D.D2R, lo = lon * D.D2R;
    return new T.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
  }
  // Earth-fixed km -> scene
  function ecefToScene(p, out) {
    const r = Math.hypot(p[0], p[1], p[2]);
    const alt = r - D.RE;
    const k = (1 + (alt / D.RE) * ALT_SCALE) / r;
    return (out || new T.Vector3()).set(p[0] * k, p[2] * k, -p[1] * k);
  }
  function sceneToLatLon(v) {
    const r = v.length();
    return { lat: Math.asin(v.y / r) * D.R2D, lon: Math.atan2(-v.z, v.x) * D.R2D };
  }

  // ------------------------------------------------------------------
  // Earth texture painted from coastlines
  // ------------------------------------------------------------------
  function paintEarth(W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = (lon) => ((lon + 180) / 360) * W, Y = (lat) => ((90 - lat) / 180) * H;
    // ocean
    const oc = g.createLinearGradient(0, 0, 0, H);
    oc.addColorStop(0, '#123a6b'); oc.addColorStop(0.5, '#0f5c8c'); oc.addColorStop(1, '#123a6b');
    g.fillStyle = oc; g.fillRect(0, 0, W, H);
    const path = (rings) => {
      const p = new Path2D();
      for (const ring of rings) {
        let prev = null;
        for (let i = 0; i < ring.length; i += 2) {
          const lon = ring[i], lat = ring[i + 1];
          if (prev === null || Math.abs(lon - prev) > 180) p.moveTo(X(lon), Y(lat));
          else p.lineTo(X(lon), Y(lat));
          prev = lon;
        }
        p.closePath();
      }
      return p;
    };
    const land = path(root.GEO.land);
    // shallow-water glow
    g.save();
    g.strokeStyle = 'rgba(80, 200, 220, 0.35)'; g.lineWidth = W / 300; g.lineJoin = 'round';
    g.stroke(land);
    g.strokeStyle = 'rgba(80, 200, 220, 0.18)'; g.lineWidth = W / 140; g.stroke(land);
    g.restore();
    // land base
    g.fillStyle = '#3f9a63'; g.fill(land);
    g.save(); g.clip(land);
    const blob = (lon, lat, rx, ry, col) => {
      const gr = g.createRadialGradient(X(lon), Y(lat), 0, X(lon), Y(lat), (rx / 360) * W);
      gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.translate(X(lon), Y(lat)); g.scale(1, ry / rx); g.translate(-X(lon), -Y(lat));
      g.fillStyle = gr; g.fillRect(X(lon - rx), Y(lat + rx), (rx * 2 / 360) * W, (rx * 2 / 180) * H);
      g.restore();
    };
    // deserts, steppe, ice
    [[15, 23, 30, 12], [45, 23, 14, 9], [71, 27, 7, 5], [105, 42, 16, 6], [-110, 33, 10, 7], [135, -25, 16, 10], [20, -24, 8, 7], [-70, -24, 5, 10], [60, 42, 10, 6]]
      .forEach(([lo, la, rx, ry]) => blob(lo, la, rx, ry, 'rgba(226, 190, 120, 0.95)'));
    [[88, 32, 12, 4], [80, 35, 6, 3]].forEach(([lo, la, rx, ry]) => blob(lo, la, rx, ry, 'rgba(190, 160, 120, 0.9)'));
    [[-20, 25, 0, 0]].forEach(() => {});
    [[0, 75, 200, 12], [-40, 72, 25, 10]].forEach(([lo, la, rx, ry]) => blob(lo, la, rx, ry, 'rgba(235, 245, 250, 0.9)'));
    [[85, 29, 10, 1.6]].forEach(([lo, la, rx, ry]) => blob(lo, la, rx, ry, 'rgba(240, 248, 255, 0.95)'));   // Himalaya snow
    [[-60, -5, 18, 10], [20, 0, 10, 6], [110, 0, 15, 6], [77, 12, 4, 6], [93, 25, 4, 3]]
      .forEach(([lo, la, rx, ry]) => blob(lo, la, rx, ry, 'rgba(30, 120, 70, 0.8)'));
    g.restore();
    g.fillStyle = 'rgba(240, 250, 255, 0.95)'; g.fillRect(0, Y(-70), W, H - Y(-70)); // Antarctica fill
    // India
    const india = path(root.GEO.india);
    g.fillStyle = 'rgba(255, 220, 160, 0.10)'; g.fill(india);
    g.strokeStyle = 'rgba(255, 159, 67, 0.95)'; g.lineWidth = W / 1600; g.stroke(india);
    g.strokeStyle = 'rgba(255, 255, 255, 0.25)'; g.lineWidth = W / 2600; g.stroke(path(root.GEO.neighbours));
    // graticule
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 15) { g.beginPath(); g.moveTo(X(lon), 0); g.lineTo(X(lon), H); g.stroke(); }
    for (let lat = -75; lat <= 75; lat += 15) { g.beginPath(); g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); g.stroke(); }
    return c;
  }

  // Night lights: Indian cities plus a few world megacities, drawn as warm glows.
  const CITIES = [
    [28.61, 77.21, 3], [19.08, 72.88, 3], [12.97, 77.59, 2.4], [22.57, 88.36, 2.6], [13.08, 80.27, 2.4], [17.39, 78.49, 2.4],
    [23.02, 72.57, 2], [18.52, 73.86, 2], [26.91, 75.79, 1.6], [26.85, 80.95, 1.7], [21.15, 79.09, 1.4], [22.72, 75.86, 1.4],
    [25.59, 85.14, 1.4], [30.73, 76.78, 1.3], [21.17, 72.83, 1.6], [17.69, 83.22, 1.3], [9.93, 76.27, 1.2], [8.52, 76.94, 1.1],
    [11.02, 76.96, 1.2], [9.92, 78.12, 1.1], [15.35, 75.14, 1], [23.26, 77.41, 1.2], [25.32, 82.97, 1.1], [27.18, 78.01, 1.1],
    [31.63, 74.87, 1.1], [32.73, 74.86, 0.9], [26.14, 91.74, 1.1], [20.30, 85.82, 1.1], [16.51, 80.65, 1.1], [15.83, 78.04, 0.9],
    [24.59, 73.71, 0.9], [29.95, 78.16, 0.9], [23.34, 85.31, 1], [21.25, 81.63, 1], [12.30, 76.64, 1], [14.68, 77.6, 0.8],
    [24.86, 67.0, 2.2], [31.52, 74.36, 2], [23.81, 90.41, 2.6], [27.72, 85.32, 1.2], [6.93, 79.85, 1.2], [33.68, 73.05, 1.4],
    [25.2, 55.27, 2], [24.71, 46.68, 1.8], [35.69, 51.39, 2.2], [39.9, 116.4, 3], [31.23, 121.47, 3], [13.75, 100.5, 2.2],
    [1.35, 103.82, 1.8], [35.68, 139.69, 3], [51.5, -0.12, 2.6], [48.86, 2.35, 2.4], [40.71, -74.0, 3], [34.05, -118.24, 2.6],
    [30.04, 31.24, 2.4], [6.52, 3.38, 2], [-23.55, -46.63, 2.6], [19.43, -99.13, 2.6], [55.75, 37.62, 2.4], [41.01, 28.98, 2.2],
  ];
  function paintLights(W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const r = D.mulberry32(9);
    const X = (lon) => ((lon + 180) / 360) * W, Y = (lat) => ((90 - lat) / 180) * H;
    g.globalCompositeOperation = 'lighter';
    for (const [lat, lon, s] of CITIES) {
      const rad = s * W / 1400;
      const gr = g.createRadialGradient(X(lon), Y(lat), 0, X(lon), Y(lat), rad * 3);
      gr.addColorStop(0, 'rgba(255,214,140,0.95)'); gr.addColorStop(0.3, 'rgba(255,170,80,0.45)'); gr.addColorStop(1, 'rgba(255,140,40,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(X(lon), Y(lat), rad * 3, 0, 7); g.fill();
      // satellite towns
      for (let k = 0; k < s * 14; k++) {
        const a = r() * 6.28, d = r() * s * 1.6;
        const x = X(lon + Math.cos(a) * d), y = Y(lat + Math.sin(a) * d * 0.8);
        g.fillStyle = `rgba(255,200,120,${0.25 + r() * 0.5})`;
        g.fillRect(x, y, W / 2400 + r() * W / 2000, W / 2400 + r() * W / 2000);
      }
    }
    // scattered village lights over the Indo-Gangetic plain and peninsula
    for (let k = 0; k < 2600; k++) {
      const lat = 9 + r() * 22, lon = 72 + r() * 17;
      const plain = lat > 24 && lat < 30 && lon > 74 && lon < 89;
      if (!plain && r() < 0.55) continue;
      g.fillStyle = `rgba(255,190,110,${0.12 + r() * 0.3})`;
      g.fillRect(X(lon), Y(lat), W / 3000, W / 3000);
    }
    return c;
  }

  // ------------------------------------------------------------------
  // Low-poly models
  // ------------------------------------------------------------------
  function satelliteModel(sat) {
    const grp = new T.Group();
    const gold = new T.MeshStandardMaterial({ color: 0xe0b24a, metalness: 0.7, roughness: 0.35, flatShading: true });
    const panel = new T.MeshStandardMaterial({ color: 0x1f3fa8, metalness: 0.4, roughness: 0.4, emissive: 0x0a1a55, flatShading: true });
    const dark = new T.MeshStandardMaterial({ color: 0x22252e, metalness: 0.5, roughness: 0.5 });
    const accent = new T.MeshStandardMaterial({ color: new T.Color(sat.colour), emissive: new T.Color(sat.colour), emissiveIntensity: 0.6 });
    const body = new T.Mesh(new T.BoxGeometry(0.016, 0.016, 0.024), gold);
    grp.add(body);
    for (const s of [-1, 1]) {
      const arm = new T.Mesh(new T.CylinderGeometry(0.0012, 0.0012, 0.012, 6), dark);
      arm.rotation.z = Math.PI / 2; arm.position.x = s * 0.014; grp.add(arm);
      const p = new T.Mesh(new T.BoxGeometry(0.036, 0.0015, 0.018), panel);
      p.position.x = s * 0.038; grp.add(p);
      // panel cells
      for (let k = -1; k <= 1; k++) {
        const line = new T.Mesh(new T.BoxGeometry(0.0006, 0.0018, 0.018), dark);
        line.position.set(s * 0.038 + k * 0.012, 0, 0); grp.add(line);
      }
    }
    if (sat.sensor === 'sar') {
      const ant = new T.Mesh(new T.BoxGeometry(0.012, 0.03, 0.05), new T.MeshStandardMaterial({ color: 0xb9b3e6, metalness: 0.3, roughness: 0.6, flatShading: true }));
      ant.position.set(0, -0.012, 0); ant.rotation.x = 0.2; grp.add(ant);
    } else {
      const cam = new T.Mesh(new T.CylinderGeometry(0.006, 0.0075, 0.012, 10), dark);
      cam.position.y = -0.013; grp.add(cam);
      const lens = new T.Mesh(new T.CircleGeometry(0.005, 12), new T.MeshStandardMaterial({ color: 0x5cc8ff, emissive: 0x1a6aa0, metalness: 0.9, roughness: 0.1 }));
      lens.rotation.x = Math.PI / 2; lens.position.y = -0.0195; grp.add(lens);
    }
    const tag = new T.Mesh(new T.SphereGeometry(0.003, 8, 8), accent);
    tag.position.set(0, 0.011, 0.01); grp.add(tag);
    grp.scale.setScalar(2.2);
    // soft glow so the satellite reads from far away
    const halo = new T.Sprite(new T.SpriteMaterial({ map: glowTexture(), color: new T.Color(sat.colour), transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending }));
    halo.scale.setScalar(0.05);
    grp.add(halo);
    return grp;
  }

  let glowTex = null;
  function glowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    glowTex = new T.CanvasTexture(c);
    return glowTex;
  }

  function stationModel() {
    const grp = new T.Group();
    const white = new T.MeshStandardMaterial({ color: 0xf2f4ff, roughness: 0.5, flatShading: true });
    const base = new T.Mesh(new T.CylinderGeometry(0.004, 0.006, 0.01, 6), white);
    base.position.y = 0.005; grp.add(base);
    const dish = new T.Mesh(new T.SphereGeometry(0.011, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), new T.MeshStandardMaterial({ color: 0xffffff, side: T.DoubleSide, roughness: 0.4, flatShading: true }));
    dish.rotation.x = Math.PI; dish.position.y = 0.02; dish.rotation.z = 0.5; grp.add(dish);
    const feed = new T.Mesh(new T.CylinderGeometry(0.0007, 0.0007, 0.012, 4), white);
    feed.position.set(0.002, 0.021, 0); grp.add(feed);
    return grp;
  }

  const TYPE_COLOURS = {
    flood: 0x4aa8ff, cyclone: 0x8c7bff, wildfire: 0xff5d3a, landslide: 0xc58b5a, volcano: 0xff3d6e,
    crop: 0x9be15d, forest: 0x2ed37a, water: 0x2ed3b7, urban: 0xd9dcef, coast: 0x5cc8ff, glacier: 0xe8f6ff,
    ice: 0xbfe8ff, drought: 0xf2c14e, energy: 0xffd166, haze: 0xbfb5a5, default: 0xffffff,
  };

  function pinModel(req) {
    const grp = new T.Group();
    const col = TYPE_COLOURS[req.type] || TYPE_COLOURS.default;
    const stem = new T.Mesh(new T.CylinderGeometry(0.0009, 0.0009, 0.03, 5), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    stem.position.y = 0.015; grp.add(stem);
    const head = new T.Mesh(new T.OctahedronGeometry(0.009, 0), new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.45, flatShading: true }));
    head.position.y = 0.034; grp.add(head);
    const ring = new T.Mesh(new T.RingGeometry(0.008, 0.011, 24), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.001; grp.add(ring);
    grp.userData = { req, head, ring, baseCol: col };
    return grp;
  }

  // Orient an object so its +Y points away from Earth's centre at position p.
  function standOn(obj, p) {
    obj.position.copy(p);
    obj.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), p.clone().normalize());
  }

  // ------------------------------------------------------------------
  // Globe
  // ------------------------------------------------------------------
  function Globe(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputEncoding = T.sRGBEncoding;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x060a1c);
    this.camera = new T.PerspectiveCamera(38, 1, 0.01, 100);
    this.camera.position.copy(ll(18, 80, 3.6));
    this.controls = new T.OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 1.25; this.controls.maxDistance = 7; this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5; this.controls.zoomSpeed = 0.7;

    this.sunDir = new T.Vector3(1, 0, 0);
    this.buildStars();
    this.buildEarth();
    this.buildLights();
    this.sats = {};
    this.pins = {};
    this.stations = [];
    this.beams = [];
    this.flashes = [];
    this.tracks = {};
    this.target = null;
    this.tween = null;
    this.follow = null;
    this.clock = new T.Clock();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  Globe.prototype.resize = function () {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  Globe.prototype.buildStars = function () {
    const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new T.Vector3(D.gauss(), D.gauss(), D.gauss()).normalize().multiplyScalar(30 + Math.random() * 20);
      pos.set([v.x, v.y, v.z], i * 3);
      const t = Math.random();
      col.set(t < 0.15 ? [1, 0.8, 0.6] : t < 0.3 ? [0.7, 0.8, 1] : [1, 1, 1], i * 3);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    this.scene.add(new T.Points(g, new T.PointsMaterial({ size: 0.08, vertexColors: true, transparent: true, opacity: 0.85, sizeAttenuation: true })));
  };

  Globe.prototype.buildEarth = function () {
    const tex = new T.CanvasTexture(paintEarth(4096, 2048));
    tex.encoding = T.sRGBEncoding;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const lights = new T.CanvasTexture(paintLights(4096, 2048));
    this.earthMat = new T.ShaderMaterial({
      uniforms: { day: { value: tex }, lights: { value: lights }, sunDir: { value: this.sunDir } },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vView;
        void main(){ vUv = uv; vN = normalize(normal); vec4 wp = modelMatrix * vec4(position,1.0);
          vView = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `
        uniform sampler2D day; uniform sampler2D lights; uniform vec3 sunDir; varying vec2 vUv; varying vec3 vN; varying vec3 vView;
        void main(){
          vec3 c = texture2D(day, vUv).rgb;
          float d = dot(vN, normalize(sunDir));
          float lit = smoothstep(-0.18, 0.25, d);
          vec3 night = c * vec3(0.30, 0.36, 0.62) + vec3(0.015, 0.02, 0.06) + texture2D(lights, vUv).rgb * 1.25;
          vec3 col = mix(night, c * (0.75 + 0.35 * max(d, 0.0)), lit);
          // warm terminator band
          col += vec3(0.35, 0.16, 0.04) * (1.0 - abs(d * 4.0)) * step(abs(d), 0.25) * 0.35;
          // ocean glint
          vec3 h = normalize(normalize(sunDir) + vView);
          float isWater = step(c.g, c.b + 0.02) * step(c.r, 0.3);
          col += vec3(0.6, 0.75, 1.0) * pow(max(dot(vN, h), 0.0), 60.0) * isWater * lit * 0.6;
          float rim = pow(1.0 - max(dot(vN, vView), 0.0), 3.0);
          col += vec3(0.25, 0.55, 1.0) * rim * 0.35 * (0.3 + lit);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.earth = new T.Mesh(new T.SphereGeometry(1, 128, 96), this.earthMat);
    this.scene.add(this.earth);

    // clouds
    this.cloudCanvas = document.createElement('canvas');
    this.cloudCanvas.width = 1024; this.cloudCanvas.height = 512;
    this.cloudTex = new T.CanvasTexture(this.cloudCanvas);
    this.cloudMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: this.cloudTex }, sunDir: { value: this.sunDir }, show: { value: 1 } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; void main(){ vUv=uv; vN=normalize(normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform sampler2D map; uniform vec3 sunDir; uniform float show; varying vec2 vUv; varying vec3 vN;
        void main(){ float a = texture2D(map, vUv).a; float lit = smoothstep(-0.2, 0.3, dot(vN, normalize(sunDir)));
          vec3 c = mix(vec3(0.10,0.12,0.22), vec3(1.0), lit); gl_FragColor = vec4(c, a * show * (0.35 + 0.6*lit)); }`,
    });
    this.clouds = new T.Mesh(new T.SphereGeometry(1.012, 96, 64), this.cloudMat);
    this.scene.add(this.clouds);
    this.paintBackgroundClouds();

    // atmosphere
    const atm = new T.ShaderMaterial({
      side: T.BackSide, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      uniforms: { sunDir: { value: this.sunDir } },
      vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(normalMatrix*normal); vW = normalize((modelMatrix*vec4(position,1.0)).xyz); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 sunDir; varying vec3 vN; varying vec3 vW; void main(){ float i = pow(0.72 - dot(vN, vec3(0,0,1.0)), 3.0);
        float lit = 0.35 + 0.65*smoothstep(-0.3, 0.4, dot(vW, normalize(sunDir)));
        gl_FragColor = vec4(vec3(0.30, 0.62, 1.0) * lit, 1.0) * i; }`,
    });
    this.scene.add(new T.Mesh(new T.SphereGeometry(1.09, 64, 48), atm));
  };

  Globe.prototype.buildLights = function () {
    this.scene.add(new T.AmbientLight(0x8090c0, 0.55));
    this.sunLight = new T.DirectionalLight(0xfff2dd, 1.4);
    this.scene.add(this.sunLight);
  };

  // Low, soft clouds elsewhere on the planet (decoration only).
  Globe.prototype.paintBackgroundClouds = function () {
    const W = 1024, H = 512;
    const img = new Uint8ClampedArray(W * H);
    const r = D.mulberry32(42);
    const puffs = [];
    for (let i = 0; i < 900; i++) puffs.push([r() * W, (0.08 + r() * 0.84) * H, 4 + r() * 22, 40 + r() * 90]);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    for (const [x, y, rad, a] of puffs) {
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${a / 255})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rad * 1.8, rad, 0, 0, Math.PI * 2); g.fill();
    }
    this.bgClouds = g.getImageData(0, 0, W, H);
    this.setClouds(null);
  };

  // fn(lat, lon) -> cloud fraction 0..1 inside the planning region.
  Globe.prototype.setClouds = function (fn) {
    const W = 1024, H = 512;
    const g = this.cloudCanvas.getContext('2d');
    const out = g.createImageData(W, H);
    const bg = this.bgClouds.data, d = out.data;
    const lat0 = 4, lat1 = 38, lon0 = 64, lon1 = 100;
    for (let y = 0; y < H; y++) {
      const lat = 90 - ((y + 0.5) / H) * 180;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const lon = ((x + 0.5) / W) * 360 - 180;
        let a = bg[i + 3];
        if (fn && lat > lat0 && lat < lat1 && lon > lon0 && lon < lon1) {
          const edge = Math.min(lat - lat0, lat1 - lat, lon - lon0, lon1 - lon) / 3;
          const w = Math.min(1, edge);
          const v = fn(lat, lon);
          // break the field into puffy texture
          const n = Math.min(1, (bg[((y * 3) % H * W + (x * 3) % W) * 4 + 3] / 255) * 1.1 + (bg[((y * 7) % H * W + (x * 7) % W) * 4 + 3] / 255) * 0.6 + 0.12);
          const ca = Math.pow(Math.max(0, v), 1.2) * 235 * n;
          a = a * (1 - w) + ca * w;
        }
        d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a;
      }
    }
    g.putImageData(out, 0, 0);
    this.cloudTex.needsUpdate = true;
  };

  Globe.prototype.setSun = function (date) {
    const s = D.eciToEcef(D.sunEci(date).v, D.gmst(date));
    this.sunDir.set(s[0], s[2], -s[1]).normalize();
    this.sunLight.position.copy(this.sunDir).multiplyScalar(10);
  };

  Globe.prototype.addSatellites = function (fleet) {
    for (const f of fleet) {
      const m = satelliteModel(f.sat);
      this.scene.add(m);
      const trailGeo = new T.BufferGeometry();
      const trail = new T.Line(trailGeo, new T.LineBasicMaterial({ color: new T.Color(f.sat.colour), transparent: true, opacity: 0.55 }));
      this.scene.add(trail);
      const groundGeo = new T.BufferGeometry();
      const ground = new T.Line(groundGeo, new T.LineDashedMaterial({ color: new T.Color(f.sat.colour), transparent: true, opacity: 0.35, dashSize: 0.01, gapSize: 0.008 }));
      this.scene.add(ground);
      this.sats[f.sat.id] = { f, m, trail, ground, pos: new T.Vector3() };
    }
  };

  Globe.prototype.updateSatellites = function (ms) {
    const date = new Date(ms);
    for (const id in this.sats) {
      const s = this.sats[id];
      const st = s.f.orbit.at(date);
      ecefToScene(st.ecef, s.pos);
      s.m.position.copy(s.pos);
      // nadir-pointing, panels across the velocity direction
      const v = ecefToScene([st.ecef[0] + st.vel[0] * 10, st.ecef[1] + st.vel[1] * 10, st.ecef[2] + st.vel[2] * 10]).sub(s.pos).normalize();
      const up = s.pos.clone().normalize();
      const x = new T.Vector3().crossVectors(v, up).normalize();
      const z = new T.Vector3().crossVectors(x, up).normalize();
      s.m.matrix.makeBasis(x, up, z);
      s.m.quaternion.setFromRotationMatrix(s.m.matrix);
      // trail: 40 minutes behind to 15 ahead
      const pts = [], gpts = [];
      for (let k = -40; k <= 15; k += 1) {
        const p = s.f.orbit.at(new Date(ms + k * 60000)).ecef;
        pts.push(ecefToScene(p));
        const g = D.ecefToGeo(p);
        gpts.push(ll(g.lat, g.lon, 1.003));
      }
      s.trail.geometry.setFromPoints(pts);
      s.ground.geometry.setFromPoints(gpts);
      s.ground.computeLineDistances();
    }
  };

  Globe.prototype.addStations = function (stations) {
    for (const st of stations) {
      const m = stationModel();
      standOn(m, ll(st.lat, st.lon, 1.0));
      this.scene.add(m);
      const beam = new T.Line(new T.BufferGeometry(), new T.LineDashedMaterial({ color: 0xff9f43, dashSize: 0.02, gapSize: 0.012, transparent: true, opacity: 0.9 }));
      beam.visible = false;
      this.scene.add(beam);
      this.stations.push({ st, m, beam, pos: ll(st.lat, st.lon, 1.02) });
    }
  };
  // links: [{stationId, satId}]
  Globe.prototype.setDownlinks = function (links) {
    for (const s of this.stations) {
      const l = links.find((k) => k.station === s.st.id);
      s.beam.visible = !!l;
      if (l) {
        s.beam.geometry.setFromPoints([s.pos, this.sats[l.sat].pos]);
        s.beam.computeLineDistances();
      }
    }
  };

  Globe.prototype.setRequests = function (reqs) {
    for (const id in this.pins) { this.scene.remove(this.pins[id]); }
    this.pins = {};
    for (const r of reqs) {
      const p = pinModel(r);
      standOn(p, ll(r.lat, r.lon, 1.0));
      this.scene.add(p);
      this.pins[r.id] = p;
    }
  };
  // state: 'idle' | 'planned' | 'clear' | 'cloudy' | 'none'
  Globe.prototype.setPinState = function (id, state) {
    const p = this.pins[id];
    if (!p) return;
    const col = { planned: 0xff9f43, clear: 0x2ed3b7, cloudy: 0xff5d73, none: 0x59607e }[state] || p.userData.baseCol;
    p.userData.head.material.color.setHex(col);
    p.userData.head.material.emissive.setHex(col);
    p.userData.ring.material.color.setHex(col);
    p.userData.state = state;
  };

  // A shot: light beam from satellite to target plus a ripple on the ground.
  Globe.prototype.shoot = function (satId, req, good) {
    const s = this.sats[satId];
    if (!s) return;
    const tgt = ll(req.lat, req.lon, 1.0);
    const dir = tgt.clone().sub(s.pos);
    const len = dir.length();
    const cone = new T.Mesh(new T.ConeGeometry(0.03, len, 24, 1, true), new T.MeshBasicMaterial({ color: good ? 0x7ff5df : 0xff8a9a, transparent: true, opacity: 0.4, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
    cone.position.copy(s.pos).add(dir.clone().multiplyScalar(0.5));
    cone.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize().negate());
    this.scene.add(cone);
    const ring = new T.Mesh(new T.RingGeometry(0.01, 0.014, 40), new T.MeshBasicMaterial({ color: good ? 0x7ff5df : 0xff8a9a, transparent: true, opacity: 1, side: T.DoubleSide, depthWrite: false }));
    standOn(ring, ll(req.lat, req.lon, 1.004));
    ring.rotateX(-Math.PI / 2);
    this.scene.add(ring);
    this.flashes.push({ cone, ring, t: 0 });
  };

  // ------------------------------------------------------------------
  // Single-target mission overlays: crosshair on the target, and the
  // ground track of every pass over it (fades in, can be struck out).
  // ------------------------------------------------------------------
  Globe.prototype.setTarget = function (lat, lon) {
    if (this.target) this.scene.remove(this.target);
    this.target = null;
    if (lat === null || lat === undefined) return;
    const mat = (col, op) => new T.MeshBasicMaterial({ color: col, transparent: true, opacity: op, side: T.DoubleSide, depthWrite: false });
    const g = new T.Group();
    const ring = new T.Mesh(new T.RingGeometry(0.017, 0.0205, 56), mat(0xffffff, 0.95));
    const dot = new T.Mesh(new T.CircleGeometry(0.005, 24), mat(0xff9f43, 1));
    g.add(ring, dot);
    for (const [x, y, w, h] of [[0.03, 0, 0.014, 0.002], [-0.03, 0, 0.014, 0.002], [0, 0.03, 0.002, 0.014], [0, -0.03, 0.002, 0.014]]) {
      const tick = new T.Mesh(new T.PlaneGeometry(w, h), mat(0xffffff, 0.9));
      tick.position.set(x, y, 0);
      g.add(tick);
    }
    const p = ll(lat, lon, 1.0045);
    g.position.copy(p);
    g.lookAt(p.clone().multiplyScalar(2));
    g.userData.ring = ring;
    this.scene.add(g);
    this.target = g;
  };
  // item: { id, pts: [[lat, lon], ...], colour }
  Globe.prototype.addTrack = function (item) {
    const pts = item.pts.map(([la, lo]) => ll(la, lo, 1.0035));
    const line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: new T.Color(item.colour), transparent: true, opacity: 0, depthWrite: false }));
    this.scene.add(line);
    this.tracks[item.id] = { line, pts, colour: item.colour, tube: null, want: 0.85 };
  };
  // state: 'kept' | 'out' | 'spare' | 'chosen'
  Globe.prototype.setTrackState = function (id, state) {
    const t = this.tracks[id];
    if (!t) return;
    if (t.tube) { this.scene.remove(t.tube); t.tube = null; }
    if (state === 'out') { t.line.material.color.set(0xff5d73); t.want = 0.18; }
    else { t.line.material.color.set(t.colour); t.want = state === 'spare' ? 0.35 : 0.9; }
    if (state === 'chosen') {
      const curve = new T.CatmullRomCurve3(t.pts);
      t.tube = new T.Mesh(new T.TubeGeometry(curve, 90, 0.0024, 6, false), new T.MeshBasicMaterial({ color: new T.Color(t.colour), transparent: true, opacity: 0.95, depthWrite: false }));
      this.scene.add(t.tube);
    }
  };
  Globe.prototype.clearTracks = function () {
    for (const id in this.tracks) { const t = this.tracks[id]; this.scene.remove(t.line); if (t.tube) this.scene.remove(t.tube); }
    this.tracks = {};
  };

  Globe.prototype.flyTo = function (lat, lon, dist, ms) {
    const from = this.camera.position.clone();
    const to = ll(lat, lon, dist || this.camera.position.length());
    this.follow = null;
    this.tween = { from, to, t: 0, dur: (ms || 1600) / 1000 };
  };
  Globe.prototype.followSat = function (id) { this.follow = id; this.tween = null; };

  Globe.prototype.pick = function (clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const v = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(v, this.camera);
    const heads = Object.values(this.pins).map((p) => p.userData.head);
    const hp = ray.intersectObjects(heads, false)[0];
    if (hp) return { req: hp.object.parent.userData.req };
    const he = ray.intersectObject(this.earth, false)[0];
    if (he) return { ground: sceneToLatLon(he.point) };
    return null;
  };

  Globe.prototype.project = function (lat, lon) {
    const p = ll(lat, lon, 1.03);
    const facing = p.clone().normalize().dot(this.camera.position.clone().normalize()) > 0.15;
    const v = p.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: facing };
  };

  Globe.prototype.render = function () {
    const dt = Math.min(0.05, this.clock.getDelta());
    const now = performance.now() / 1000;
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const k = tw.t >= 1 ? 1 : 1 - Math.pow(1 - tw.t, 3);
      const a = tw.from.clone().normalize(), b = tw.to.clone().normalize();
      const r = tw.from.length() + (tw.to.length() - tw.from.length()) * k;
      const q = new T.Quaternion().setFromUnitVectors(a, b);
      const qk = new T.Quaternion().slerp(q, k);
      this.camera.position.copy(a.applyQuaternion(qk).multiplyScalar(r));
      if (tw.t >= 1) this.tween = null;
    } else if (this.follow && this.sats[this.follow]) {
      const p = this.sats[this.follow].pos;
      const want = p.clone().normalize().multiplyScalar(Math.max(1.9, Math.min(2.6, this.camera.position.length())));
      // sit slightly behind and above the satellite so it stays in frame
      this.camera.position.lerp(want, 0.18);
    }
    for (const id in this.pins) {
      const p = this.pins[id];
      const u = p.userData;
      u.head.rotation.y += dt * 1.2;
      const urgent = u.req.source === 'event' || u.req.urgency >= 0.7;
      const s = urgent ? 1 + 0.6 * ((now * 1.3) % 1) : 1;
      u.ring.scale.setScalar(s);
      u.ring.material.opacity = urgent ? 0.9 * (1 - ((now * 1.3) % 1)) : 0.7;
    }
    if (this.target) this.target.userData.ring.scale.setScalar(1 + 0.18 * Math.sin(now * 4));
    for (const id in this.tracks) {
      const m = this.tracks[id].line.material;
      m.opacity += (this.tracks[id].want - m.opacity) * Math.min(1, dt * 5);
    }
    this.flashes = this.flashes.filter((f) => {
      f.t += dt;
      f.cone.material.opacity = Math.max(0, 0.45 * (1 - f.t / 1.2));
      f.ring.scale.setScalar(1 + f.t * 4);
      f.ring.material.opacity = Math.max(0, 1 - f.t / 1.4);
      if (f.t > 1.4) { this.scene.remove(f.cone); this.scene.remove(f.ring); return false; }
      return true;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  root.Globe = Globe;
  root.GlobeUtil = { ll, ecefToScene, sceneToLatLon, TYPE_COLOURS };
})(window);
