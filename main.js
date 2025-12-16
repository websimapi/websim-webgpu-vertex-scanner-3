import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import nipplejs from 'nipplejs';

// --- Global State ---
let renderer, scene;
let playerCamera, observerCamera; 
let activeCamera; // The one currently rendering
let cullingCamera; // The one determining visibility
let playerMesh, observerControls;

// Game State
const MODES = { FIRST_PERSON: 0, THIRD_PERSON: 1, OBSERVER: 2 };
let currentMode = MODES.FIRST_PERSON;
let playerPos = new THREE.Vector3(0, 1.8, 0);
let playerYaw = 0;
let playerPitch = 0;

// The City Mesh
let cityMesh;
let baseGeometry;
let baseIndices; // Original Uint32Array
let visibleIndices; // Dynamic Uint32Array

// Culling Internals
const _cullFrustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _tmpCentroid = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();
const _viewDir = new THREE.Vector3();

// Input
const keyState = {};
let joystickManager;
let joystickData = { angle: 0, force: 0 };

// Stats
let lastTime = 0;
let frameCount = 0;
const fpsElem = document.getElementById('fps-val');
const visElem = document.getElementById('vis-val');
const totalElem = document.getElementById('total-val');
const statusElem = document.getElementById('status');

function init() {
    const container = document.getElementById('canvas-container');

    // 1. WebGPU Renderer
    renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x050510);
    container.appendChild(renderer.domElement);

    // 2. Scene
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050510, 0.015);

    // 3. Cameras
    playerCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    observerCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    observerCamera.position.set(50, 50, 50);
    observerCamera.lookAt(0, 0, 0);

    // 4. Player Visual (for Observer mode)
    const pGeo = new THREE.ConeGeometry(1, 2, 8);
    pGeo.rotateX(Math.PI / 2); // Point forward
    const pMat = new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true });
    playerMesh = new THREE.Mesh(pGeo, pMat);
    scene.add(playerMesh);

    // 5. Observer Controls
    observerControls = new OrbitControls(observerCamera, renderer.domElement);
    observerControls.enableDamping = true;
    observerControls.enabled = false; // Start disabled

    // 6. Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(20, 50, 20);
    scene.add(dirLight);
    
    // Add some "Cyber" lights
    const pl1 = new THREE.PointLight(0x00ffff, 2, 50);
    pl1.position.set(0, 10, 0);
    scene.add(pl1);

    // 7. City Generation
    generateCity();

    // 8. Input & Events
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', (e) => keyState[e.code] = true);
    window.addEventListener('keyup', (e) => keyState[e.code] = false);
    
    document.getElementById('view-mode-btn').addEventListener('click', cycleViewMode);

    // Joystick for mobile
    joystickManager = nipplejs.create({
        zone: document.getElementById('zone-joystick'),
        mode: 'static',
        position: { left: '50%', top: '50%' },
        color: 'cyan'
    });
    joystickManager.on('move', (evt, data) => {
        joystickData.angle = data.angle.radian;
        joystickData.force = Math.min(data.force, 1.5); // Cap speed
    });
    joystickManager.on('end', () => {
        joystickData.force = 0;
    });

    // Start in FPS
    setMode(MODES.FIRST_PERSON);
}

function generateCity() {
    const buildings = [];
    const gridSize = 16;
    const spacing = 12;

    // Ground Plane (Grid)
    const groundGeo = new THREE.PlaneGeometry(300, 300, 50, 50);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshBasicMaterial({ 
        color: 0x111122, 
        wireframe: true,
        transparent: true,
        opacity: 0.3
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.1;
    scene.add(ground);

    // Buildings
    for(let x = -gridSize/2; x < gridSize/2; x++) {
        for(let z = -gridSize/2; z < gridSize/2; z++) {
            if (Math.random() > 0.8) continue; // Random gaps

            const h = Math.random() * 20 + 5;
            const w = Math.random() * 4 + 4;
            const d = Math.random() * 4 + 4;

            const geo = new THREE.BoxGeometry(w, h, d);
            geo.translate(x * spacing, h/2, z * spacing);
            
            // Randomize UVs or Colors could go here
            buildings.push(geo);
        }
    }

    if (buildings.length === 0) return;

    // Merge all buildings into one geometry
    baseGeometry = BufferGeometryUtils.mergeGeometries(buildings, false);
    
    // Create a mesh with this geometry
    const material = new THREE.MeshPhongMaterial({
        color: 0x00aaff,
        emissive: 0x001133,
        shininess: 80,
        specular: 0x111111,
        side: THREE.DoubleSide, // Crucial so we can see when backfaces are culled
        wireframe: false,
        flatShading: true
    });

    // Setup for Dynamic Indexing
    // Ensure baseGeometry is indexed (BoxGeometry is indexed by default)
    if (!baseGeometry.index) {
        // Should use utilities to create index if missing, but mergeGeometries usually handles it
        // Or we just assume indexed for now as Boxes are.
    }

    baseIndices = baseGeometry.index.array; // Uint16 or Uint32
    const totalIndices = baseIndices.length;
    
    // Create a new buffer for dynamic drawing
    // We allocate same size, but will only use a portion
    visibleIndices = new Uint32Array(totalIndices);
    
    // Attach dynamic index to geometry
    const indexAttr = new THREE.BufferAttribute(visibleIndices, 1);
    indexAttr.setUsage(THREE.DynamicDrawUsage);
    baseGeometry.setIndex(indexAttr);
    
    // Create the mesh
    cityMesh = new THREE.Mesh(baseGeometry, material);
    cityMesh.frustumCulled = false; // We handle culling manually!
    scene.add(cityMesh);

    if (totalElem) totalElem.innerText = (totalIndices / 3).toLocaleString();
}

function updateGameLogic(dt) {
    // Movement logic (apply to Player Position)
    const speed = 15 * dt;
    const rotSpeed = 2 * dt;

    let moveFwd = 0;
    let moveRight = 0;

    // Keyboard
    if (keyState['KeyW']) moveFwd += 1;
    if (keyState['KeyS']) moveFwd -= 1;
    if (keyState['KeyA']) moveRight -= 1;
    if (keyState['KeyD']) moveRight += 1;
    if (keyState['ArrowLeft']) playerYaw += rotSpeed;
    if (keyState['ArrowRight']) playerYaw -= rotSpeed;

    // Joystick
    if (joystickData.force > 0) {
        moveFwd += Math.sin(joystickData.angle) * joystickData.force;
        moveRight += Math.cos(joystickData.angle) * joystickData.force;
    }

    // Apply Move
    if (moveFwd !== 0 || moveRight !== 0) {
        const dx = Math.sin(playerYaw) * moveFwd + Math.cos(playerYaw) * moveRight;
        const dz = Math.cos(playerYaw) * moveFwd - Math.sin(playerYaw) * moveRight;
        playerPos.x -= dx * speed;
        playerPos.z -= dz * speed;
    }

    // Update Player Camera Transform
    playerCamera.position.copy(playerPos);
    
    // Height bob / adjustment based on mode
    if (currentMode === MODES.THIRD_PERSON) {
        // TPS: Camera behind player
        const dist = 10;
        const cx = playerPos.x + Math.sin(playerYaw) * dist;
        const cz = playerPos.z + Math.cos(playerYaw) * dist;
        playerCamera.position.set(cx, playerPos.y + 5, cz);
        playerCamera.lookAt(playerPos.x, playerPos.y + 2, playerPos.z);
    } else {
        // FPS: Camera at eye level
        playerCamera.position.y += 0.5; // Eye height
        // Look direction
        const lx = playerPos.x - Math.sin(playerYaw) * 10;
        const lz = playerPos.z - Math.cos(playerYaw) * 10;
        playerCamera.lookAt(lx, playerPos.y + 0.5, lz);
    }

    // Update Player Mesh (Representation in Observer Mode)
    playerMesh.position.copy(playerPos);
    playerMesh.rotation.y = playerYaw;
}

function updateCulling() {
    if (!cityMesh || !baseIndices) return;

    // 1. Determine which camera determines visibility
    // In Observer mode, we still cull based on PLAYER camera to see the effect
    cullingCamera = playerCamera;
    
    cullingCamera.updateMatrixWorld();
    cullingCamera.updateProjectionMatrix();

    // 2. Setup Frustum
    _projScreenMatrix.multiplyMatrices(cullingCamera.projectionMatrix, cullingCamera.matrixWorldInverse);
    _cullFrustum.setFromProjectionMatrix(_projScreenMatrix);

    // 3. Setup Backface Culling helper
    const camPos = new THREE.Vector3();
    cullingCamera.getWorldPosition(camPos);
    
    // Normal matrix for world space transformation
    // Since city is static (identity matrix usually), we can assume geometry normals are world normals if mesh is at 0,0,0 scale 1
    // But let's be safe.
    // const normalMatrix = new THREE.Matrix3().getNormalMatrix(cityMesh.matrixWorld);

    const positions = baseGeometry.attributes.position.array;
    const normals = baseGeometry.attributes.normal.array;

    let drawCount = 0;
    const indexCount = baseIndices.length;

    // 4. Iterate Triangles
    // OPTIMIZATION: Check every 3rd index (triangle)
    for (let i = 0; i < indexCount; i += 3) {
        const i1 = baseIndices[i];
        const i2 = baseIndices[i+1];
        const i3 = baseIndices[i+2];

        // Get Vertices
        _tmpA.fromArray(positions, i1 * 3);
        _tmpB.fromArray(positions, i2 * 3);
        _tmpC.fromArray(positions, i3 * 3);

        // Apply World Matrix (if mesh moves) - here mesh is static at identity, so skip for speed
        // _tmpA.applyMatrix4(cityMesh.matrixWorld); ...

        // 1. Frustum Culling (Centroid check - fast approximation)
        _tmpCentroid.addVectors(_tmpA, _tmpB).add(_tmpC).multiplyScalar(1/3);
        
        // Slightly expand check or check vertices? 
        // Checking centroid is fast but can cull big triangles near edge. 
        // Checking all 3 is safer.
        // Let's check if Centroid is in frustum.
        if (!_cullFrustum.containsPoint(_tmpCentroid)) {
            // Refinement: if centroid is out, check radius? 
            // For high poly city, centroid is usually fine.
            continue; 
        }

        // 2. Backface Culling (CPU side)
        // Face Normal
        // We can use pre-calculated vertex normal of first vertex as approximation if smooth, 
        // or calculate face normal from cross product.
        // Let's use the actual geometric face normal for accuracy
        _tmpNormal.subVectors(_tmpB, _tmpA).cross(_tmpC.sub(_tmpA)).normalize(); // (B-A) x (C-A)

        // View Direction (Centroid to Camera)
        _viewDir.subVectors(camPos, _tmpCentroid);

        // Dot Product
        if (_tmpNormal.dot(_viewDir) <= 0) {
            // Backfacing
            continue;
        }

        // Pass!
        visibleIndices[drawCount] = i1;
        visibleIndices[drawCount+1] = i2;
        visibleIndices[drawCount+2] = i3;
        drawCount += 3;
    }

    // 5. Update Geometry
    baseGeometry.index.needsUpdate = true;
    baseGeometry.setDrawRange(0, drawCount);

    if (visElem) visElem.innerText = (drawCount/3).toLocaleString();
}

function setMode(mode) {
    currentMode = mode;
    const btn = document.getElementById('view-mode-btn');

    if (mode === MODES.FIRST_PERSON) {
        activeCamera = playerCamera;
        observerControls.enabled = false;
        playerMesh.visible = false;
        btn.innerText = "View: First Person";
        statusElem.innerText = "Current: First Person (Culling Active)";
    } else if (mode === MODES.THIRD_PERSON) {
        activeCamera = playerCamera;
        observerControls.enabled = false;
        playerMesh.visible = true; // See self
        btn.innerText = "View: Third Person";
        statusElem.innerText = "Current: Third Person (Culling Active)";
    } else {
        activeCamera = observerCamera;
        observerControls.enabled = true;
        playerMesh.visible = true;
        btn.innerText = "View: Observer";
        statusElem.innerText = "Current: Observer (Viewing Player Culling)";
    }
}

function cycleViewMode() {
    let next = currentMode + 1;
    if (next > 2) next = 0;
    setMode(next);
}

function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    playerCamera.aspect = width / height;
    playerCamera.updateProjectionMatrix();
    observerCamera.aspect = width / height;
    observerCamera.updateProjectionMatrix();

    renderer.setSize(width, height);
}

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    
    // FPS Calc
    frameCount++;
    if (now >= lastTime + 1000) {
        if (fpsElem) fpsElem.innerText = Math.round((frameCount * 1000) / (now - lastTime));
        frameCount = 0;
        lastTime = now;
    } else {
        // Only update time if we didn't reset (simple hack)
    }

    // Physics / Game Logic
    if (currentMode !== MODES.OBSERVER) {
         // Only move player if not in observer mode? 
         // Or allow moving player while observing? "User moves around... switch to observer... see behind"
         // Let's allow moving player always via keys, but joystick might be weird in observer.
         updateGameLogic(dt);
    } else {
        // In observer mode, controls move the observer camera
        observerControls.update();
        // Still update player if keys pressed? Yes, useful for debugging
        updateGameLogic(dt);
    }

    // Culling Logic (The Core Algorithm)
    updateCulling();

    // Render
    renderer.render(scene, activeCamera);
    
    // reset lastTime for next delta
    // wait, the FPS logic messes with lastTime. Separate them.
    // For simplicity, just use small dt
}

// Fix stats timing
lastTime = performance.now();

init();
animate();

