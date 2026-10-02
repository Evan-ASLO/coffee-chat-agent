import * as THREE from "./vendor/three.module.min.js";

const COLORS = {
	forest: 0x173b2e,
	forestDeep: 0x0e2a21,
	sage: 0x9fb59b,
	sageLight: 0xd5dfcb,
	cream: 0xf4ead8,
	creamLight: 0xfff8eb,
	orange: 0xc86034,
	orangeLight: 0xf3a16f,
	coffee: 0x5f3829,
	sky: 0xd7e3d5,
	charcoal: 0x25352f,
	gold: 0xe3b35d,
};

export function supportsWebGL() {
	try {
		const canvas = document.createElement("canvas");
		return Boolean(
			window.WebGL2RenderingContext &&
				canvas.getContext("webgl2", {
					failIfMajorPerformanceCaveat: true,
				}),
		);
	} catch {
		return false;
	}
}

export function createJourneyScene(options) {
	const {
		container,
		metrics,
		onFocus = () => {},
		onHover = () => {},
		onReady = () => {},
		onError = () => {},
	} = options;
	if (!container || !supportsWebGL()) {
		throw new Error("WebGL is unavailable.");
	}

	const mobile = window.matchMedia("(max-width: 760px)").matches;
	const reducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	const config = window.CareerJourney.sceneConfig({
		mobile,
		reducedMotion,
	});
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 100);
	const baseCamera = new THREE.Vector3(7.4, 5.1, 9.2);
	const baseLookAt = new THREE.Vector3(0, -0.1, -0.2);
	const desiredCamera = baseCamera.clone();
	const desiredLookAt = baseLookAt.clone();
	const currentLookAt = baseLookAt.clone();
	camera.position.copy(baseCamera);
	camera.lookAt(baseLookAt);

	let renderer;
	try {
		renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: config.antialias,
			powerPreference: "high-performance",
		});
	} catch (error) {
		onError(error);
		throw error;
	}
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.dprCap));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.04;
	renderer.shadowMap.enabled = config.shadows;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.domElement.className = "journey-webgl-canvas";
	renderer.domElement.setAttribute(
		"aria-label",
		"Interactive career journey desk. Use the nearby buttons for keyboard access.",
	);
	renderer.domElement.setAttribute("role", "img");
	container.appendChild(renderer.domElement);

	const world = new THREE.Group();
	world.rotation.y = -0.08;
	scene.add(world);
	const interactive = new Map();
	const animated = [];
	const pointer = new THREE.Vector2();
	const raycaster = new THREE.Raycaster();
	let hoveredArea = "";
	let focusedArea = "";
	let pointerX = 0;
	let pointerY = 0;
	let frameId = 0;
	let inViewport = true;
	let disposed = false;
	let lastFrame = performance.now();

	addLighting(scene);
	const skyline = createTorontoSkyline();
	world.add(skyline);
	const desk = createDesk();
	world.add(desk);

	const path = createJourneyPath(metrics);
	path.position.set(-0.4, -0.78, -1.05);
	register(path, "journey");
	world.add(path);

	const cup = createCoffeeCup(metrics);
	cup.position.set(-2.85, -0.65, 0.42);
	register(cup, "networking");
	world.add(cup);
	animated.push(...cup.userData.animated);

	const laptop = createLaptop(metrics);
	laptop.position.set(-0.2, -0.7, 0.2);
	register(laptop, "applications");
	world.add(laptop);

	const notebook = createNotebook(metrics);
	notebook.position.set(2.45, -0.7, 0.72);
	notebook.rotation.y = -0.16;
	register(notebook, "saved");
	world.add(notebook);

	const plant = createPlant(metrics, config.geometryDetail);
	plant.position.set(3.05, -0.68, -1.13);
	register(plant, "progress");
	world.add(plant);
	animated.push(...plant.userData.animated);

	const warmLight = new THREE.PointLight(COLORS.orangeLight, 23, 18, 2);
	warmLight.position.set(-1.8, 3.2, 3.5);
	scene.add(warmLight);

	const resizeObserver =
		typeof ResizeObserver === "function"
			? new ResizeObserver(resize)
			: null;
	if (resizeObserver) {
		resizeObserver.observe(container);
	} else {
		window.addEventListener("resize", resize);
	}
	const intersectionObserver =
		typeof IntersectionObserver === "function"
			? new IntersectionObserver(
					(entries) => {
						inViewport = entries[0]?.isIntersecting !== false;
						updateAnimationState();
					},
					{ threshold: 0.08 },
				)
			: null;
	intersectionObserver?.observe(container);
	document.addEventListener("visibilitychange", updateAnimationState);
	renderer.domElement.addEventListener("pointermove", handlePointerMove);
	renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
	renderer.domElement.addEventListener("click", handleClick);
	resize();
	renderOnce();
	updateAnimationState();
	onReady(renderer.domElement);

	function register(group, area) {
		group.userData.area = area;
		group.userData.baseScale = group.scale.clone();
		interactive.set(area, group);
		group.traverse((object) => {
			if (object.isMesh) {
				object.castShadow = config.shadows;
				object.receiveShadow = config.shadows;
			}
		});
	}

	function handlePointerMove(event) {
		const rect = renderer.domElement.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		pointerX = pointer.x;
		pointerY = pointer.y;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(
			Array.from(interactive.values()),
			true,
		);
		const area = areaForObject(hits[0]?.object);
		setHovered(area);
		if (!config.animate) renderOnce();
	}

	function handlePointerLeave() {
		pointerX = 0;
		pointerY = 0;
		setHovered("");
		if (!config.animate) renderOnce();
	}

	function handleClick() {
		if (!hoveredArea) return;
		focus(hoveredArea);
		onFocus(hoveredArea);
	}

	function areaForObject(object) {
		let entry = object;
		while (entry) {
			if (entry.userData?.area) return entry.userData.area;
			entry = entry.parent;
		}
		return "";
	}

	function setHovered(area) {
		if (hoveredArea === area) return;
		hoveredArea = area;
		renderer.domElement.classList.toggle("is-interactive", Boolean(area));
		onHover(area);
	}

	function focus(area) {
		const target = interactive.get(area);
		if (!target) return;
		focusedArea = area;
		const position = new THREE.Vector3();
		target.getWorldPosition(position);
		desiredLookAt.copy(position);
		desiredCamera.set(position.x + 3.6, position.y + 2.5, position.z + 5.3);
		if (!config.animate) {
			camera.position.copy(desiredCamera);
			currentLookAt.copy(desiredLookAt);
			camera.lookAt(currentLookAt);
			renderOnce();
		}
	}

	function reset() {
		focusedArea = "";
		desiredCamera.copy(baseCamera);
		desiredLookAt.copy(baseLookAt);
		onHover("");
		if (!config.animate) {
			camera.position.copy(baseCamera);
			currentLookAt.copy(baseLookAt);
			camera.lookAt(currentLookAt);
			renderOnce();
		}
	}

	function resize() {
		if (disposed) return;
		const width = Math.max(1, Math.floor(container.clientWidth));
		const height = Math.max(1, Math.floor(container.clientHeight));
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		renderOnce();
	}

	function updateAnimationState() {
		if (disposed) return;
		const shouldAnimate =
			config.animate &&
			inViewport &&
			document.visibilityState !== "hidden";
		if (shouldAnimate && !frameId) {
			lastFrame = performance.now();
			frameId = requestAnimationFrame(animate);
		} else if (!shouldAnimate && frameId) {
			cancelAnimationFrame(frameId);
			frameId = 0;
			renderOnce();
		}
	}

	function animate(now) {
		if (disposed) return;
		frameId = 0;
		const delta = Math.min(0.04, Math.max(0, (now - lastFrame) / 1000));
		lastFrame = now;
		const followX = config.cameraFollow && !focusedArea ? pointerX * 0.38 : 0;
		const followY = config.cameraFollow && !focusedArea ? pointerY * 0.2 : 0;
		const cameraTarget = desiredCamera.clone().add(
			new THREE.Vector3(followX, followY, 0),
		);
		camera.position.lerp(cameraTarget, 1 - Math.pow(0.001, delta));
		currentLookAt.lerp(desiredLookAt, 1 - Math.pow(0.001, delta));
		camera.lookAt(currentLookAt);
		skyline.position.x +=
			(pointerX * 0.12 - skyline.position.x) *
			Math.min(1, delta * 2.8);
		warmLight.position.x +=
			(-1.8 + pointerX * 1.1 - warmLight.position.x) *
			Math.min(1, delta * 3);
		warmLight.position.y +=
			(3.2 + pointerY * 0.5 - warmLight.position.y) *
			Math.min(1, delta * 3);
		for (const entry of animated) entry(now, delta);
		for (const [area, group] of interactive) {
			const active = area === hoveredArea || area === focusedArea;
			const targetScale = active ? 1.045 : 1;
			group.scale.lerp(
				group.userData.baseScale.clone().multiplyScalar(targetScale),
				Math.min(1, delta * 8),
			);
		}
		renderer.render(scene, camera);
		updateAnimationState();
	}

	function renderOnce() {
		if (!disposed) renderer.render(scene, camera);
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (frameId) cancelAnimationFrame(frameId);
		resizeObserver?.disconnect();
		if (!resizeObserver) window.removeEventListener("resize", resize);
		intersectionObserver?.disconnect();
		document.removeEventListener("visibilitychange", updateAnimationState);
		renderer.domElement.removeEventListener("pointermove", handlePointerMove);
		renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
		renderer.domElement.removeEventListener("click", handleClick);
		scene.traverse((object) => {
			if (!object.isMesh) return;
			object.geometry?.dispose();
			const materials = Array.isArray(object.material)
				? object.material
				: [object.material];
			for (const material of materials) {
				if (!material) continue;
				for (const value of Object.values(material)) {
					if (value?.isTexture) value.dispose();
				}
				material.dispose();
			}
		});
		renderer.dispose();
		renderer.forceContextLoss();
		renderer.domElement.remove();
	}

	return { dispose, focus, reset };
}

function addLighting(scene) {
	const hemisphere = new THREE.HemisphereLight(
		COLORS.creamLight,
		COLORS.forestDeep,
		2.8,
	);
	scene.add(hemisphere);
	const key = new THREE.DirectionalLight(COLORS.cream, 3.5);
	key.position.set(5, 8, 7);
	key.castShadow = true;
	key.shadow.mapSize.set(768, 768);
	key.shadow.camera.near = 1;
	key.shadow.camera.far = 25;
	key.shadow.camera.left = -8;
	key.shadow.camera.right = 8;
	key.shadow.camera.top = 8;
	key.shadow.camera.bottom = -8;
	scene.add(key);
	const fill = new THREE.DirectionalLight(COLORS.sageLight, 1.3);
	fill.position.set(-5, 4, 2);
	scene.add(fill);
}

function createDesk() {
	const group = new THREE.Group();
	const top = mesh(
		new THREE.BoxGeometry(9.2, 0.46, 5.1),
		material(COLORS.cream, 0.74, 0.08),
	);
	top.position.y = -1.12;
	top.receiveShadow = true;
	group.add(top);
	for (const x of [-3.8, 3.8]) {
		for (const z of [-1.75, 1.75]) {
			const leg = mesh(
				new THREE.CapsuleGeometry(0.15, 2.5, 4, 8),
				material(COLORS.forest, 0.72),
			);
			leg.position.set(x, -2.42, z);
			group.add(leg);
		}
	}
	const edge = mesh(
		new THREE.BoxGeometry(8.5, 0.06, 0.08),
		material(COLORS.orange, 0.54, 0.08),
	);
	edge.position.set(0, -0.86, 2.53);
	group.add(edge);
	return group;
}

function createTorontoSkyline() {
	const group = new THREE.Group();
	group.position.set(0, -0.36, -3.35);
	const skylineMaterial = material(COLORS.forest, 0.9);
	const sageMaterial = material(COLORS.sage, 0.88);
	const buildings = [
		[-4.1, 1.15, 0.72, 2.2],
		[-3.25, 0.75, 0.56, 1.35],
		[-2.55, 1.3, 0.84, 2.65],
		[-1.55, 0.7, 0.62, 1.25],
		[0.9, 0.78, 0.84, 1.5],
		[1.92, 1.08, 0.72, 2.12],
		[2.85, 0.72, 0.62, 1.3],
		[3.65, 1.2, 0.8, 2.35],
	];
	for (const [x, y, width, height] of buildings) {
		const building = mesh(
			new THREE.BoxGeometry(width, height, 0.38),
			x > 1.5 ? sageMaterial.clone() : skylineMaterial.clone(),
		);
		building.position.set(x, y, 0);
		group.add(building);
	}
	const tower = new THREE.Group();
	const needle = mesh(
		new THREE.CylinderGeometry(0.035, 0.075, 3.4, 8),
		material(COLORS.orange, 0.65),
	);
	needle.position.y = 2.36;
	tower.add(needle);
	const deck = mesh(
		new THREE.SphereGeometry(0.28, 12, 8),
		material(COLORS.orangeLight, 0.56, 0.14),
	);
	deck.scale.y = 0.38;
	deck.position.y = 2.26;
	tower.add(deck);
	const base = mesh(
		new THREE.CylinderGeometry(0.2, 0.44, 1.8, 8),
		material(COLORS.forestDeep, 0.76),
	);
	base.position.y = 0.9;
	tower.add(base);
	tower.position.x = -0.2;
	group.add(tower);
	return group;
}

function createCoffeeCup(metrics) {
	const group = new THREE.Group();
	group.userData.animated = [];
	const cupMaterial = material(COLORS.orange, 0.42, 0.05);
	const body = mesh(
		new THREE.CylinderGeometry(0.52, 0.43, 1.02, 18),
		cupMaterial,
	);
	body.position.y = 0.12;
	group.add(body);
	const rim = mesh(
		new THREE.TorusGeometry(0.5, 0.055, 8, 20),
		material(COLORS.creamLight, 0.36),
	);
	rim.rotation.x = Math.PI / 2;
	rim.position.y = 0.64;
	group.add(rim);
	const coffee = mesh(
		new THREE.CylinderGeometry(0.43, 0.43, 0.025, 18),
		material(COLORS.coffee, 0.25, 0.02),
	);
	coffee.position.y = 0.64;
	group.add(coffee);
	const handle = mesh(
		new THREE.TorusGeometry(0.31, 0.09, 8, 16, Math.PI * 1.45),
		cupMaterial.clone(),
	);
	handle.rotation.y = Math.PI / 2;
	handle.rotation.z = -0.76;
	handle.position.set(0.48, 0.12, 0);
	group.add(handle);
	for (let index = 0; index < Math.max(1, metrics.cupLevel); index += 1) {
		const dot = mesh(
			new THREE.SphereGeometry(0.045, 8, 6),
			material(COLORS.creamLight, 0.4, 0.08),
		);
		dot.position.set(-0.22 + (index % 3) * 0.22, 0.05, 0.44);
		group.add(dot);
	}
	for (let index = 0; index < 2; index += 1) {
		const curve = new THREE.CatmullRomCurve3([
			new THREE.Vector3(-0.12 + index * 0.24, 0.72, 0),
			new THREE.Vector3(0.04 + index * 0.16, 1.08, 0.02),
			new THREE.Vector3(-0.08 + index * 0.2, 1.4, -0.03),
		]);
		const steam = mesh(
			new THREE.TubeGeometry(curve, 10, 0.018, 5, false),
			new THREE.MeshBasicMaterial({
				color: COLORS.creamLight,
				transparent: true,
				opacity: 0.48,
			}),
		);
		steam.userData.offset = index * Math.PI;
		group.add(steam);
		group.userData.animated.push((now) => {
			steam.position.y = Math.sin(now * 0.0012 + steam.userData.offset) * 0.04;
			steam.material.opacity =
				0.34 + Math.sin(now * 0.001 + steam.userData.offset) * 0.12;
		});
	}
	return group;
}

function createLaptop(metrics) {
	const group = new THREE.Group();
	const dark = material(COLORS.charcoal, 0.42, 0.32);
	const base = mesh(new THREE.BoxGeometry(2.25, 0.13, 1.42), dark);
	base.position.y = 0.02;
	group.add(base);
	const keyboard = mesh(
		new THREE.BoxGeometry(1.55, 0.025, 0.74),
		material(COLORS.sageLight, 0.82),
	);
	keyboard.position.set(0, 0.095, 0.2);
	group.add(keyboard);
	const screenMaterial = new THREE.MeshStandardMaterial({
		color: COLORS.forestDeep,
		emissive: COLORS.orange,
		emissiveIntensity: 0.12 + metrics.laptopGlow * 0.55,
		metalness: 0.24,
		roughness: 0.42,
	});
	const screen = mesh(
		new THREE.BoxGeometry(2.22, 1.42, 0.12),
		screenMaterial,
	);
	screen.position.set(0, 0.82, -0.62);
	screen.rotation.x = -0.12;
	group.add(screen);
	const display = mesh(
		new THREE.PlaneGeometry(1.86, 1.08),
		new THREE.MeshBasicMaterial({ color: COLORS.creamLight }),
	);
	display.position.set(0, 0.82, -0.552);
	display.rotation.x = -0.12;
	group.add(display);
	const stageCounts = [
		metrics.applied,
		metrics.interviews,
		metrics.offers,
	].map((count) => Math.min(1, count / 4));
	stageCounts.forEach((amount, index) => {
		const bar = mesh(
			new THREE.BoxGeometry(0.32 + amount * 0.95, 0.12, 0.025),
			new THREE.MeshBasicMaterial({
				color: [COLORS.sage, COLORS.orangeLight, COLORS.orange][index],
			}),
		);
		bar.position.set(-0.74 + (0.32 + amount * 0.95) / 2, 1.06 - index * 0.3, -0.485);
		bar.rotation.x = -0.12;
		group.add(bar);
	});
	return group;
}

function createNotebook(metrics) {
	const group = new THREE.Group();
	const cover = mesh(
		new THREE.BoxGeometry(1.62, 0.16, 1.92),
		material(COLORS.forest, 0.8),
	);
	group.add(cover);
	for (let index = 0; index < metrics.notebookPages; index += 1) {
		const page = mesh(
			new THREE.BoxGeometry(1.5, 0.025, 1.8),
			material(COLORS.creamLight, 0.96),
		);
		page.position.set(0.03 * (index % 2), 0.1 + index * 0.026, 0);
		group.add(page);
	}
	const binding = mesh(
		new THREE.CylinderGeometry(0.06, 0.06, 1.76, 8),
		material(COLORS.gold, 0.55, 0.2),
	);
	binding.rotation.x = Math.PI / 2;
	binding.position.set(-0.7, 0.18, 0);
	group.add(binding);
	const bookmark = mesh(
		new THREE.BoxGeometry(0.18, 0.04, 1.2),
		material(COLORS.orange, 0.56),
	);
	bookmark.position.set(0.48, 0.21, 0.54);
	group.add(bookmark);
	return group;
}

function createPlant(metrics, detail) {
	const group = new THREE.Group();
	group.userData.animated = [];
	const pot = mesh(
		new THREE.CylinderGeometry(0.55, 0.42, 0.8, 14),
		material(COLORS.orange, 0.72),
	);
	pot.position.y = 0.02;
	group.add(pot);
	const soil = mesh(
		new THREE.CylinderGeometry(0.49, 0.49, 0.04, 14),
		material(COLORS.coffee, 0.92),
	);
	soil.position.y = 0.43;
	group.add(soil);
	const plantHeight = 0.68 + metrics.plantLevel * 0.16;
	const stem = mesh(
		new THREE.CylinderGeometry(0.045, 0.06, plantHeight, 7),
		material(COLORS.forest, 0.8),
	);
	stem.position.y = 0.42 + plantHeight / 2;
	group.add(stem);
	const leafCount = Math.max(3, metrics.leafCount - (detail === 0 ? 3 : 0));
	for (let index = 0; index < leafCount; index += 1) {
		const leaf = mesh(
			new THREE.SphereGeometry(0.22, detail === 0 ? 7 : 10, 6),
			material(index % 3 === 0 ? COLORS.sageLight : COLORS.sage, 0.86),
		);
		leaf.scale.set(1.28, 0.48, 0.72);
		const angle = index * 2.28;
		const height = 0.66 + (index / Math.max(1, leafCount - 1)) * plantHeight;
		leaf.position.set(
			Math.cos(angle) * (0.24 + (index % 2) * 0.07),
			height,
			Math.sin(angle) * 0.24,
		);
		leaf.rotation.z = Math.cos(angle) * 0.55;
		leaf.rotation.y = angle;
		leaf.userData.baseY = leaf.rotation.y;
		group.add(leaf);
		group.userData.animated.push((now) => {
			leaf.rotation.y =
				leaf.userData.baseY + Math.sin(now * 0.00075 + index) * 0.05;
		});
	}
	return group;
}

function createJourneyPath(metrics) {
	const group = new THREE.Group();
	const points = [
		[-2.55, 0.1],
		[-1.7, -0.28],
		[-0.8, -0.05],
		[0.15, -0.34],
		[1.05, -0.08],
		[1.82, -0.36],
	];
	points.forEach(([x, z], index) => {
		const active = index <= metrics.pathLevel + 1;
		const stone = mesh(
			new THREE.CylinderGeometry(0.22, 0.25, 0.07, 10),
			material(active ? COLORS.orangeLight : COLORS.sageLight, 0.86),
		);
		stone.position.set(x, 0, z);
		group.add(stone);
	});
	metrics.milestones.forEach((milestone, index) => {
		const flag = new THREE.Group();
		const pole = mesh(
			new THREE.CylinderGeometry(0.018, 0.025, 0.64, 6),
			material(COLORS.forestDeep, 0.74),
		);
		pole.position.y = 0.34;
		flag.add(pole);
		const cloth = mesh(
			new THREE.PlaneGeometry(0.36, 0.21),
			new THREE.MeshBasicMaterial({
				color: milestone.active ? COLORS.orange : COLORS.sage,
				side: THREE.DoubleSide,
			}),
		);
		cloth.position.set(0.18, 0.55, 0);
		flag.add(cloth);
		const point = points[Math.min(points.length - 1, index + 1)];
		flag.position.set(point[0], 0.03, point[1]);
		group.add(flag);
	});
	return group;
}

function mesh(geometry, meshMaterial) {
	return new THREE.Mesh(geometry, meshMaterial);
}

function material(color, roughness = 0.68, metalness = 0.02) {
	return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
