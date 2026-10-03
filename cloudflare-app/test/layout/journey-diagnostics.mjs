import { baseUrl } from "./browser-helpers.mjs";

export async function installJourneyDiagnostics(context) {
	await context.addInitScript(({ origin }) => {
		if (location.origin !== origin) return;
		const diagnostics = {
			contexts: [], observers: [], visibilityListeners: new Set(),
			frames: new Map(), disposed: { geometries: 0, materials: 0, textures: 0 },
			visibilityOverride: "",
		};
		window.__layoutJourney = diagnostics;
		const getContext = HTMLCanvasElement.prototype.getContext;
		const seenContexts = new WeakSet();
		const seenExtensions = new WeakSet();
		HTMLCanvasElement.prototype.getContext = function (...args) {
			const result = getContext.apply(this, args);
			if (!result || !["webgl", "webgl2", "experimental-webgl"].includes(args[0]) || seenContexts.has(result)) {
				return result;
			}
			seenContexts.add(result);
			const record = { canvas: this, context: result, lossRequested: false };
			diagnostics.contexts.push(record);
			const getExtension = result.getExtension;
			result.getExtension = function (...extensionArgs) {
				const extension = getExtension.apply(this, extensionArgs);
				if (extensionArgs[0] === "WEBGL_lose_context" && extension && !seenExtensions.has(extension)) {
					seenExtensions.add(extension);
					const loseContext = extension.loseContext;
					extension.loseContext = function (...lossArgs) {
						record.lossRequested = true;
						return loseContext.apply(this, lossArgs);
					};
				}
				return extension;
			};
			return result;
		};
		for (const name of ["ResizeObserver", "IntersectionObserver"]) {
			const NativeObserver = window[name];
			if (!NativeObserver) continue;
			window[name] = class extends NativeObserver {
				constructor(callback) {
					super(callback);
					this.targets = new Set();
					diagnostics.observers.push(this);
				}
				observe(target, ...args) {
					this.targets.add(target);
					return super.observe(target, ...args);
				}
				unobserve(target) {
					this.targets.delete(target);
					return super.unobserve(target);
				}
				disconnect() {
					this.targets.clear();
					return super.disconnect();
				}
			};
		}
		const add = document.addEventListener.bind(document);
		const remove = document.removeEventListener.bind(document);
		document.addEventListener = (type, listener, options) => {
			if (type === "visibilitychange") diagnostics.visibilityListeners.add(listener);
			return add(type, listener, options);
		};
		document.removeEventListener = (type, listener, options) => {
			if (type === "visibilitychange") diagnostics.visibilityListeners.delete(listener);
			return remove(type, listener, options);
		};
		const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => diagnostics.visibilityOverride || visibility.call(document),
		});
		const requestFrame = window.requestAnimationFrame.bind(window);
		const cancelFrame = window.cancelAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) => {
			const id = requestFrame((time) => {
				diagnostics.frames.delete(id);
				callback(time);
			});
			diagnostics.frames.set(id, callback.name);
			return id;
		};
		window.cancelAnimationFrame = (id) => {
			diagnostics.frames.delete(id);
			return cancelFrame(id);
		};
		diagnostics.ready = import(`${origin}/vendor/three.module.min.js`).then((three) => {
			const addObject = three.Object3D.prototype.add;
			three.Object3D.prototype.add = function (...args) {
				if (this.isScene) diagnostics.scene = this;
				return addObject.apply(this, args);
			};
			const lookAt = three.Object3D.prototype.lookAt;
			three.Object3D.prototype.lookAt = function (...args) {
				if (this.isPerspectiveCamera) diagnostics.camera = this;
				return lookAt.apply(this, args);
			};
			for (const [type, key] of [
				["BufferGeometry", "geometries"], ["Material", "materials"], ["Texture", "textures"],
			]) {
				const original = three[type].prototype.dispose;
				three[type].prototype.dispose = function (...args) {
					diagnostics.disposed[key] += 1;
					return original.apply(this, args);
				};
			}
		});
	}, { origin: baseUrl });
}

export async function interactiveJourneyPoints(page) {
	return page.evaluate(() => {
		const { scene, camera } = window.__layoutJourney;
		const canvas = document.querySelector(".journey-webgl-canvas");
		const rect = canvas.getBoundingClientRect();
		const points = [];
		scene.traverse((mesh) => {
			if (!mesh.isMesh) return;
			let group = mesh;
			while (group && !group.userData.area) group = group.parent;
			const area = group?.userData.area;
			if (!area || area === "journey") return;
			mesh.geometry.computeBoundingSphere();
			const projected = mesh.geometry.boundingSphere.center.clone()
				.applyMatrix4(mesh.matrixWorld).project(camera);
			const x = Math.round(rect.left + (projected.x + 1) * rect.width / 2);
			const y = Math.round(rect.top + (1 - projected.y) * rect.height / 2);
			if (x >= rect.left && x <= rect.right && y >= Math.max(rect.top, 0) &&
				y <= Math.min(rect.bottom, innerHeight) && document.elementFromPoint(x, y) === canvas) {
				points.push({ x, y, area });
			}
		});
		return points;
	});
}

export async function readJourneyDiagnostics(page) {
	return page.evaluate(() => {
		const diagnostics = window.__layoutJourney;
		const canvas = document.querySelector(".journey-webgl-canvas");
		const rect = canvas?.getBoundingClientRect();
		return {
			activeContexts: diagnostics.contexts.filter((entry) => !entry.context.isContextLost()).length,
			lossRequests: diagnostics.contexts.filter((entry) => entry.lossRequested).length,
			observedTargets: diagnostics.observers.reduce((total, observer) => total + observer.targets.size, 0),
			visibilityListeners: diagnostics.visibilityListeners.size,
			animationFrames: [...diagnostics.frames.values()].filter((name) => name === "animate").length,
			disposed: { ...diagnostics.disposed },
			canvasCount: document.querySelectorAll(".journey-webgl-canvas").length,
			pixelRatio: rect ? canvas.width / rect.width : null,
		};
	});
}
